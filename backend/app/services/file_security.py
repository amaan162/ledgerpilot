import re
import struct
from dataclasses import dataclass

import pymupdf

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB enterprise ceiling
MAX_IMAGE_EDGE_PX = 10_000
MAX_IMAGE_PIXELS = 40_000_000  # 40 MP decompression-bomb ceiling
MAX_PDF_PAGES = 50
MAX_PDF_XREFS = 10_000

ALLOWED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg"}

MAGIC_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "pdf": (b"%PDF-",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
}

# Known executable, archive, script, and XML/SVG polyglot headers blocked unconditionally
DANGEROUS_PREFIXES = (
    b"MZ",  # Windows PE/EXE/DLL
    b"\x7fELF",  # Linux ELF binary
    b"PK\x03\x04",  # ZIP / Office macro archive
    b"#!",  # Shell script
    b"<!DOCTYPE",
    b"<!doctype",
    b"<html",
    b"<HTML",
    b"<script",
    b"<SCRIPT",
    b"<svg",
    b"<SVG",
    b"<?xml",
    b"<?php",
)

# High-risk PDF active-content & exfiltration dictionary tokens (scanned on PDF xref dictionaries)
PDF_EXPLOIT_TOKENS: list[tuple[str, re.Pattern[str]]] = [
    ("PDF_JAVASCRIPT_PAYLOAD", re.compile(r"/(?:JavaScript|JS)\b")),
    ("PDF_LAUNCH_ACTION", re.compile(r"/Launch\b")),
    ("PDF_AUTO_EXEC_ACTION", re.compile(r"/(?:OpenAction|AA)\b")),
    ("PDF_EMBEDDED_FILE_DROPPER", re.compile(r"/(?:EmbeddedFile|EmbeddedFiles|RichMedia)\b")),
    ("PDF_REMOTE_EXFIL_ACTION", re.compile(r"/(?:SubmitForm|ImportData|GoToR|GoToE)\b")),
    ("PDF_XFA_ACTIVE_FORM", re.compile(r"/XFA\b")),
]

_JPEG_SOF_MARKERS = {
    0xC0,
    0xC1,
    0xC2,
    0xC3,
    0xC5,
    0xC6,
    0xC7,
    0xC9,
    0xCA,
    0xCB,
    0xCD,
    0xCE,
    0xCF,
}

SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]")


class FileSecurityError(ValueError):
    """Raised when an uploaded document fails enterprise file-security validation."""


@dataclass(frozen=True)
class PDFExploitFinding:
    code: str
    xref: int
    detail: str


def sanitize_filename(raw_name: str) -> str:
    """Strips directory traversal segments and unsafe characters from uploaded filenames."""
    base = (raw_name or "invoice.pdf").replace("\\", "/").rsplit("/", 1)[-1].strip()
    cleaned = SAFE_FILENAME_RE.sub("_", base).lstrip(".")
    return cleaned[:160] or "invoice.pdf"


def _validate_image_dimensions(ext: str, file_bytes: bytes) -> None:
    """Lightweight header-only dimension guard blocking image decompression bombs."""
    width = 0
    height = 0

    if ext == "png" and len(file_bytes) >= 24 and file_bytes[12:16] == b"IHDR":
        width, height = struct.unpack(">II", file_bytes[16:24])
    elif ext in {"jpg", "jpeg"} and len(file_bytes) >= 11:
        pos = 2
        length = len(file_bytes)
        while pos + 4 < length:
            if file_bytes[pos] != 0xFF:
                break
            while pos < length and file_bytes[pos] == 0xFF:
                pos += 1
            if pos >= length:
                break
            marker = file_bytes[pos]
            pos += 1
            if marker in (0xD8, 0xD9, 0x01) or (0xD0 <= marker <= 0xD7):
                continue
            if marker == 0xDA or pos + 2 > length:
                break
            seg_len = struct.unpack(">H", file_bytes[pos : pos + 2])[0]
            if seg_len < 2 or pos + seg_len > length:
                break
            if marker in _JPEG_SOF_MARKERS and seg_len >= 7:
                height, width = struct.unpack(">HH", file_bytes[pos + 3 : pos + 7])
                break
            pos += seg_len

    if width and height:
        if width > MAX_IMAGE_EDGE_PX or height > MAX_IMAGE_EDGE_PX or (width * height) > MAX_IMAGE_PIXELS:
            raise FileSecurityError(
                f"Blocked oversized image ({width}x{height}px); exceeds 40 MP decompression-bomb limit."
            )


def validate_uploaded_document(filename: str, file_bytes: bytes) -> str:
    """
    Enforces size bounds, extension allowlisting, anti-polyglot checks,
    magic-byte verification, and image decompression-bomb guards before storage or AI ingestion.
    Returns the sanitized filename.
    """
    safe_name = sanitize_filename(filename)
    if not file_bytes:
        raise FileSecurityError("Uploaded file is empty.")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise FileSecurityError(f"File exceeds maximum allowed size ({MAX_UPLOAD_BYTES // (1024 * 1024)} MB).")

    ext = safe_name.lower().rsplit(".", 1)[-1] if "." in safe_name else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise FileSecurityError(
            f"Unsupported file extension '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}."
        )

    head = file_bytes[:64].lstrip()
    for bad_sig in DANGEROUS_PREFIXES:
        if head.startswith(bad_sig):
            raise FileSecurityError("Blocked dangerous or polyglot file signature (executable/script/archive).")

    expected_sigs = MAGIC_SIGNATURES[ext]
    if not any(file_bytes.startswith(sig) for sig in expected_sigs):
        raise FileSecurityError(f"File content magic bytes do not match claimed '.{ext}' document format.")

    if ext in {"png", "jpg", "jpeg"}:
        _validate_image_dimensions(ext, file_bytes)

    return safe_name


def scan_pdf_active_exploits(doc: pymupdf.Document) -> list[PDFExploitFinding]:
    """
    Inspects PDF structure and object dictionaries via PyMuPDF xref table for structural bombs,
    encrypted containers, and weaponized active content (/JavaScript, /Launch, /OpenAction,
    /EmbeddedFile, /SubmitForm, /GoToR, /XFA) with zero false positives on binary streams.
    """
    findings: list[PDFExploitFinding] = []
    seen_codes: set[str] = set()

    if getattr(doc, "is_encrypted", False):
        seen_codes.add("PDF_ENCRYPTED_CONTAINER")
        findings.append(
            PDFExploitFinding(
                code="PDF_ENCRYPTED_CONTAINER",
                xref=0,
                detail="Password-protected or encrypted PDF container blocked by security policy.",
            )
        )

    page_count = len(doc)
    if page_count > MAX_PDF_PAGES:
        seen_codes.add("PDF_PAGE_BOMB_LIMIT_EXCEEDED")
        findings.append(
            PDFExploitFinding(
                code="PDF_PAGE_BOMB_LIMIT_EXCEEDED",
                xref=0,
                detail=f"PDF contains {page_count} pages (exceeds {MAX_PDF_PAGES}-page ceiling).",
            )
        )

    total_xrefs = doc.xref_length()
    if total_xrefs > MAX_PDF_XREFS:
        seen_codes.add("PDF_XREF_BOMB_LIMIT_EXCEEDED")
        findings.append(
            PDFExploitFinding(
                code="PDF_XREF_BOMB_LIMIT_EXCEEDED",
                xref=0,
                detail=f"PDF contains {total_xrefs} xref objects (exceeds {MAX_PDF_XREFS}-object ceiling).",
            )
        )

    scan_limit = min(total_xrefs, MAX_PDF_XREFS)
    for xref in range(1, scan_limit):
        try:
            obj_def = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        if not obj_def:
            continue
        for code, pattern in PDF_EXPLOIT_TOKENS:
            if code not in seen_codes and pattern.search(obj_def):
                seen_codes.add(code)
                findings.append(
                    PDFExploitFinding(
                        code=code,
                        xref=xref,
                        detail=f"Weaponized PDF active-content token detected in object xref={xref}.",
                    )
                )

    return findings