"""Settings from the environment (the repository's .env locally, App Service settings in Azure).

Secrets never leave the server: they are read here and used only by backend code.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if not os.environ.get("ONWARD_TESTING"):
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:  # pragma: no cover - python-dotenv is in requirements
        pass


def _list(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # Azure SQL: Entra ID through DefaultAzureCredential (Managed Identity in Azure, developer sign-in locally).
    sql_server: str = ""
    sql_database: str = ""
    azure_client_id: str = ""
    sql_odbc_driver: str = "ODBC Driver 18 for SQL Server"
    # Podavo family accounts (shared database podavo-mdm): sessions are read there.
    mdm_sql_server: str = "sql-podavo-mdm.database.windows.net"
    mdm_sql_database: str = "podavo-mdm"

    # Public address of the app (cookies, CSRF origin check, Google redirect).
    app_base_url: str = "http://localhost:8000"
    # Node server that still answers the endpoints not yet moved to FastAPI.
    node_upstream: str = "http://127.0.0.1:3000"

    google_client_id: str = ""
    google_client_secret: str = ""
    # ID tokens from the Android/iOS apps may carry these audiences as well as the web client id.
    google_native_client_ids: tuple[str, ...] = ()
    admin_emails: frozenset[str] = frozenset()

    # Origins of the native apps' web views; they call the API with a bearer token, never cookies.
    native_origins: tuple[str, ...] = ("capacitor://localhost", "https://localhost", "http://localhost")

    # Photos: private ADLS Gen2 file system, or a local folder for development.
    photo_storage: str = "local"  # "adls" or "local"
    adls_account_url: str = ""
    adls_file_system: str = "trip-photos"
    local_photo_dir: str = str(ROOT / ".cache" / "photos")
    photo_max_bytes: int = 20 * 1024 * 1024
    photo_chunk_bytes: int = 4 * 1024 * 1024

    session_ttl_seconds: int = 7 * 24 * 60 * 60
    secure_cookies: bool = False
    extra_admins: tuple[str, ...] = field(default_factory=tuple)

    @property
    def app_origin(self) -> str:
        from urllib.parse import urlsplit

        parts = urlsplit(self.app_base_url)
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def google_web_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret and self.app_base_url)

    @property
    def google_audiences(self) -> tuple[str, ...]:
        return tuple(x for x in (self.google_client_id, *self.google_native_client_ids) if x)


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    base = env.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")
    return Settings(
        sql_server=env.get("AZURE_SQL_SERVER", ""),
        sql_database=env.get("AZURE_SQL_DATABASE", ""),
        azure_client_id=env.get("AZURE_CLIENT_ID", ""),
        sql_odbc_driver=env.get("SQL_ODBC_DRIVER", "ODBC Driver 18 for SQL Server"),
        mdm_sql_server=env.get("MDM_SQL_SERVER", "sql-podavo-mdm.database.windows.net"),
        mdm_sql_database=env.get("MDM_SQL_DATABASE", "podavo-mdm"),
        app_base_url=base,
        node_upstream=env.get("NODE_UPSTREAM", "http://127.0.0.1:3000").rstrip("/"),
        google_client_id=env.get("GOOGLE_CLIENT_ID", ""),
        google_client_secret=env.get("GOOGLE_CLIENT_SECRET", ""),
        google_native_client_ids=tuple(_list(env.get("GOOGLE_NATIVE_CLIENT_IDS"))),
        admin_emails=frozenset(e.lower() for e in _list(env.get("ADMIN_EMAILS"))),
        native_origins=tuple(_list(env.get("NATIVE_ORIGINS")) or ("capacitor://localhost", "https://localhost", "http://localhost")),
        photo_storage=env.get("PHOTO_STORAGE", "adls" if env.get("ADLS_ACCOUNT_URL") else "local"),
        adls_account_url=env.get("ADLS_ACCOUNT_URL", ""),
        adls_file_system=env.get("ADLS_FILE_SYSTEM", "trip-photos"),
        local_photo_dir=env.get("LOCAL_PHOTO_DIR", str(ROOT / ".cache" / "photos")),
        secure_cookies=base.startswith("https://"),
    )
