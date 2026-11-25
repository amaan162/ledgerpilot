import re
from dataclasses import dataclass

import pymupdf

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB enterprise ceiling
ALLOWED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg"}

MAGIC_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "pdf": (b"%PDF-",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
}

# Known executable, archive, and web-script polyglot headers blocked unconditionally
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
)

# High-risk PDF active-content dictionary tokens (scanned strictly on PDF object dictionaries)
PDF_EXPLOIT_TOKENS: list[tuple[str, re.Pattern[str]]] = [
    ("PDF_JAVASCRIPT_PAYLOAD", re.compile(r"/(?:JavaScript|JS)\b")),
    ("PDF_LAUNCH_ACTION", re.compile(r"/Launch\b")),
    ("PDF_AUTO_EXEC_ACTION", re.compile(r"/(?:OpenAction|AA)\b")),
    ("PDF_EMBEDDED_FILE_DROPPER", re.compile(r"/(?:EmbeddedFile|EmbeddedFiles|RichMedia)\b")),
]

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


def validate_uploaded_document(filename: str, file_bytes: bytes) -> str:
    """
    Enforces size bounds, extension allowlisting, anti-polyglot checks,
    and true magic-byte verification before bytes touch storage or AI models.
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

    return safe_name


def scan_pdf_active_exploits(doc: pymupdf.Document) -> list[PDFExploitFinding]:
    """
    Inspects PDF object dictionaries via PyMuPDF xref table for weaponized active content
    (/JavaScript, /Launch, /OpenAction, /EmbeddedFile) with zero false positives on binary streams.
    """
    findings: list[PDFExploitFinding] = []
    seen_codes: set[str] = set()

    for xref in range(1, doc.xref_length()):
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
