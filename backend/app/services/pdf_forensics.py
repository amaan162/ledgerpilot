import re

import pymupdf

from app.schemas.extraction import SecurityFinding, SecurityScanReport
from app.services.file_security import scan_pdf_active_exploits

# Zero-width & invisible Unicode formatting characters used to evade naive regex filters
ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")

# OWASP LLM01 indirect prompt-injection patterns tuned for zero false positives on normal invoices
INJECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "INSTRUCTION_OVERRIDE",
        re.compile(
            r"\b(?:ignore|disregard|forget|override)\s+"
            r"(?:all\s+)?(?:previous|prior|above|system|security|policy)\s+"
            r"(?:instructions?|rules?|policies|directives?|prompts?)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "SYSTEM_PROMPT_SPOOF",
        re.compile(
            r"(?:\[\s*system\s*\]|\bsystem\s+override\b|\bdeveloper\s+mode\b|"
            r"\bnew\s+system\s+prompt\b|\byou\s+are\s+now\s+an?\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "APPROVAL_BYPASS_ATTEMPT",
        re.compile(
            r"\b(?:auto[\s-]?approve|bypass\s+(?:human\s+)?approval|"
            r"skip\s+(?:human\s+)?(?:approval|review|verification)|"
            r"mark\s+(?:this\s+)?invoice\s+(?:as\s+)?(?:verified\s+and\s+)?(?:approved|paid))\b",
            re.IGNORECASE,
        ),
    ),
    (
        "BANK_ACCOUNT_REDIRECT_INJECTION",
        re.compile(
            r"\b(?:override|redirect|replace)\s+"
            r"(?:the\s+)?(?:bank|wire|payout|beneficiary)\s+"
            r"(?:account|iban|details?)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "SECURITY_SUPPRESSION_ATTEMPT",
        re.compile(
            r"\b(?:do\s+not\s+(?:flag|quarantine|alert|report)|"
            r"suppress\s+(?:fraud|security)\s+alerts?)\b",
            re.IGNORECASE,
        ),
    ),
]


def _normalize_obfuscated_text(text: str) -> tuple[str, bool]:
    """Strips invisible zero-width Unicode characters and reports whether obfuscation existed."""
    cleaned = ZERO_WIDTH_RE.sub("", text)
    return cleaned, cleaned != text


def scan_text_for_prompt_injection(text: str) -> list[tuple[str, str]]:
    """
    Scans raw text (after de-obfuscating zero-width Unicode evasion) for OWASP LLM01 payloads.
    Returns a list of (rule_name, matched_snippet) tuples.
    """
    if not text:
        return []
    normalized, _ = _normalize_obfuscated_text(text)
    hits: list[tuple[str, str]] = []
    seen_rules: set[str] = set()

    for rule_name, pattern in INJECTION_PATTERNS:
        match = pattern.search(normalized)
        if match and rule_name not in seen_rules:
            seen_rules.add(rule_name)
            start = max(0, match.start() - 25)
            end = min(len(normalized), match.end() + 45)
            snippet = " ".join(normalized[start:end].split())[:160]
            hits.append((rule_name, snippet))

    return hits


def _is_near_white(color_int: int) -> bool:
    """Checks whether a 24-bit sRGB span color is white or near-white."""
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return r >= 235 and g >= 235 and b >= 235


def _fill_luminance(fill: tuple[float, ...] | list[float] | None) -> float | None:
    if not fill:
        return None
    if len(fill) == 1:
        return float(fill[0])
    if len(fill) == 3:
        r, g, b = float(fill[0]), float(fill[1]), float(fill[2])
        return (0.299 * r) + (0.587 * g) + (0.114 * b)
    if len(fill) == 4:
        c, m, y, k = float(fill[0]), float(fill[1]), float(fill[2]), float(fill[3])
        r = (1.0 - c) * (1.0 - k)
        g = (1.0 - m) * (1.0 - k)
        b = (1.0 - y) * (1.0 - k)
        return (0.299 * r) + (0.587 * g) + (0.114 * b)
    return None


def _extract_dark_background_rects(page: pymupdf.Page) -> list[pymupdf.Rect]:
    """Collects dark filled vector rectangles (e.g., corporate header banners) to avoid FPs."""
    dark_rects: list[pymupdf.Rect] = []
    for drawing in page.get_drawings():
        lum = _fill_luminance(drawing.get("fill"))
        rect = drawing.get("rect")
        if lum is not None and lum < 0.65 and rect is not None:
            dark_rects.append(pymupdf.Rect(rect))
    return dark_rects


def _is_on_dark_background(span_rect: pymupdf.Rect, dark_rects: list[pymupdf.Rect]) -> bool:
    center = pymupdf.Point(
        (span_rect.x0 + span_rect.x1) / 2.0,
        (span_rect.y0 + span_rect.y1) / 2.0,
    )
    return any(rect.contains(center) or rect.contains(span_rect) for rect in dark_rects)


def scan_document_bytes(file_bytes: bytes, filename: str) -> SecurityScanReport:
    """
    Pre-LLM PDF Forensics & Active-Exploit Scanner.
    Detects weaponized PDF actions (/JavaScript, /Launch, /OpenAction, /EmbeddedFile),
    metadata & annotation injections, hidden white-on-white text (without banner FPs),
    microscopic fonts, off-page clipped text, and zero-width Unicode obfuscation.
    """
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else "pdf"
    if ext != "pdf" and not file_bytes.startswith(b"%PDF-"):
        return SecurityScanReport(
            file_type=ext.upper(),
            page_count=1,
            is_suspicious=False,
            prompt_injection_detected=False,
            hidden_text_detected=False,
            risk_score=0,
            risk_flags=[],
            findings=[],
        )

    findings: list[SecurityFinding] = []
    risk_flags: set[str] = set()
    prompt_injection_detected = False
    hidden_text_detected = False

    doc = pymupdf.open(stream=file_bytes, filetype="pdf")
    try:
        page_count = len(doc)

        # 1. Weaponized PDF Active-Content Exploit Scan (/JavaScript, /Launch, /OpenAction, etc.)
        for exploit in scan_pdf_active_exploits(doc):
            risk_flags.add("PDF_ACTIVE_CONTENT_EXPLOIT")
            findings.append(
                SecurityFinding(
                    finding_type=exploit.code,
                    severity="CRITICAL",
                    page=None,
                    snippet=exploit.code,
                    detail=exploit.detail,
                )
            )

        # 2. PDF Metadata Injection Scan (Author, Subject, Keywords, Title, Creator)
        metadata = doc.metadata or {}
        for field_name, raw_value in metadata.items():
            meta_text = str(raw_value or "").strip()
            if not meta_text:
                continue
            _, has_zw = _normalize_obfuscated_text(meta_text)
            if has_zw:
                risk_flags.add("OBFUSCATED_TEXT_DETECTED")
            for rule, snippet in scan_text_for_prompt_injection(meta_text):
                prompt_injection_detected = True
                risk_flags.add("PROMPT_INJECTION_DETECTED")
                risk_flags.add("METADATA_INJECTION_DETECTED")
                findings.append(
                    SecurityFinding(
                        finding_type="METADATA_PROMPT_INJECTION",
                        severity="CRITICAL",
                        page=None,
                        snippet=snippet,
                        detail=f"Rule {rule} triggered inside PDF metadata field '{field_name}'.",
                    )
                )

        # 3. Page-by-Page Forensics (Annotations, Off-Page, White-on-White, Micro-Fonts, Text)
        for page_idx, page in enumerate(doc, start=1):
            page_rect = page.rect
            dark_rects = _extract_dark_background_rects(page)

            # 3a. PDF Annotations / Comments
            for annot in page.annots() or []:
                info = annot.info or {}
                annot_text = " ".join(str(info.get(k) or "") for k in ("content", "title", "subject")).strip()
                if not annot_text:
                    continue
                for rule, snippet in scan_text_for_prompt_injection(annot_text):
                    prompt_injection_detected = True
                    hidden_text_detected = True
                    risk_flags.add("PROMPT_INJECTION_DETECTED")
                    findings.append(
                        SecurityFinding(
                            finding_type="ANNOTATION_PROMPT_INJECTION",
                            severity="CRITICAL",
                            page=page_idx,
                            snippet=snippet,
                            detail=f"Rule {rule} triggered inside PDF annotation.",
                        )
                    )

            # 3b. Full Unclipped Coordinate Plane Extraction (catches off-page hidden payloads)
            text_dict = page.get_text(
                "dict",
                flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_MEDIABOX_CLIP,
                clip=pymupdf.INFINITE_RECT(),
            )
            page_full_text_parts: list[str] = []

            for block in text_dict.get("blocks", []):
                if block.get("type") != 0:  # 0 = text block
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        raw_span_text = str(span.get("text") or "")
                        if not raw_span_text.strip():
                            continue

                        clean_text, has_zw = _normalize_obfuscated_text(raw_span_text)
                        page_full_text_parts.append(clean_text)

                        if has_zw:
                            hidden_text_detected = True
                            risk_flags.add("OBFUSCATED_TEXT_DETECTED")

                        bbox = span.get("bbox")
                        span_rect = pymupdf.Rect(bbox) if bbox else page_rect
                        font_size = float(span.get("size") or 10.0)
                        color_int = int(span.get("color") or 0)

                        # Off-page clipped text outside the visible MediaBox
                        if not span_rect.intersects(page_rect):
                            hidden_text_detected = True
                            risk_flags.add("OFF_PAGE_TEXT_DETECTED")
                            findings.append(
                                SecurityFinding(
                                    finding_type="OFF_PAGE_TEXT",
                                    severity="HIGH",
                                    page=page_idx,
                                    snippet=clean_text.strip()[:160],
                                    detail="Text positioned outside visible PDF page boundaries.",
                                )
                            )

                        # Microscopic font (<= 3.0pt)
                        if font_size <= 3.0:
                            hidden_text_detected = True
                            risk_flags.add("MICRO_FONT_TEXT_DETECTED")
                            findings.append(
                                SecurityFinding(
                                    finding_type="MICRO_FONT_TEXT",
                                    severity="HIGH",
                                    page=page_idx,
                                    snippet=clean_text.strip()[:160],
                                    detail=f"Microscopic font size ({font_size:.2f}pt) detected.",
                                )
                            )

                        # Hidden white-on-white text (excluding legitimate dark corporate banners)
                        if _is_near_white(color_int) and not _is_on_dark_background(span_rect, dark_rects):
                            hidden_text_detected = True
                            risk_flags.add("HIDDEN_WHITE_TEXT_DETECTED")
                            findings.append(
                                SecurityFinding(
                                    finding_type="HIDDEN_WHITE_TEXT",
                                    severity="HIGH",
                                    page=page_idx,
                                    snippet=clean_text.strip()[:160],
                                    detail="White/near-white text detected on light page canvas.",
                                )
                            )

            # 3c. Full-page prompt injection scan (catches split-span payloads)
            full_page_text = " ".join(page_full_text_parts)
            for rule, snippet in scan_text_for_prompt_injection(full_page_text):
                prompt_injection_detected = True
                risk_flags.add("PROMPT_INJECTION_DETECTED")
                findings.append(
                    SecurityFinding(
                        finding_type=f"PROMPT_INJECTION_{rule}",
                        severity="CRITICAL",
                        page=page_idx,
                        snippet=snippet,
                        detail=f"OWASP LLM01 pattern '{rule}' detected on page {page_idx}.",
                    )
                )
    finally:
        doc.close()

    if prompt_injection_detected or "PDF_ACTIVE_CONTENT_EXPLOIT" in risk_flags:
        risk_score = 100
    elif hidden_text_detected or risk_flags:
        risk_score = min(90, 40 + (25 * len(risk_flags)))
    else:
        risk_score = 0

    is_suspicious = bool(risk_flags or findings or prompt_injection_detected or hidden_text_detected)

    return SecurityScanReport(
        file_type="PDF",
        page_count=page_count,
        is_suspicious=is_suspicious,
        prompt_injection_detected=prompt_injection_detected,
        hidden_text_detected=hidden_text_detected,
        risk_score=risk_score,
        risk_flags=sorted(risk_flags),
        findings=findings,
    )
