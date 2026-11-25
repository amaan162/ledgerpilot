from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Always resolves to C:\Projects\ledgerpilot regardless of working directory
REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Application
    APP_ENV: str = "development"
    APP_NAME: str = "LedgerPilot"
    LOG_LEVEL: str = "INFO"
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    # PostgreSQL + pgvector
    DATABASE_URL: str
    SYNC_DATABASE_URL: str
    CHECKPOINT_DATABASE_URL: str

    # LangGraph security
    LANGGRAPH_STRICT_MSGPACK: bool = True

    # LLM Provider
    LLM_PROVIDER: str = "gemini"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.8-flash"
    GEMINI_FALLBACK_MODELS: str = "gemini-3.6-flash,gemini-3.5-flash-lite"
    GEMINI_EMBEDDING_MODEL: str = "gemini-embedding-001"
    EMBEDDING_DIMENSIONS: int = 768

    # Security & RBAC Dev API Keys
    WEBHOOK_HMAC_SECRET: str
    ADMIN_API_KEY: str
    CONTROLLER_API_KEY: str
    MANAGER_API_KEY: str
    CLERK_API_KEY: str

    # Enterprise ISO 20022 (pain.001) Settlement Engine
    SETTLEMENT_MODE: str = "iso20022"
    SETTLEMENT_OUTPUT_DIR: str = "./settlements"
    DEBTOR_COMPANY_NAME: str = "LedgerPilot Global Holdings Ltd"
    DEBTOR_IBAN: str = "GB29NWBK60161331926819"
    DEBTOR_BIC: str = "NWBKGB2L"

    # Edge Orchestrator (n8n)
    N8N_WEBHOOK_BASE_URL: str = "http://localhost:5678/webhook"

    @property
    def settlement_dir_path(self) -> Path:
        raw = Path(self.SETTLEMENT_OUTPUT_DIR)
        return raw if raw.is_absolute() else (REPO_ROOT / raw).resolve()

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
