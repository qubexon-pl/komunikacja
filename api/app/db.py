"""Azure SQL connections through ODBC with an Entra ID access token.

DefaultAzureCredential uses the App Service's Managed Identity in Azure (AZURE_CLIENT_ID picks a user-assigned one)
and the developer's Azure CLI / VS Code sign-in locally, the same as the Node server. No password is stored anywhere.
"""
from __future__ import annotations

import struct
import threading
import time
from contextlib import contextmanager
from typing import Iterator

import pyodbc

from .config import Settings

SQL_COPT_SS_ACCESS_TOKEN = 1256  # msodbcsql pre-connect attribute for an Entra ID token
SQL_SCOPE = "https://database.windows.net/.default"

# Let the ODBC driver manager pool connections (the token is part of the pooled connection's attributes).
pyodbc.pooling = True


class Database:
    def __init__(self, settings: Settings, server: str | None = None, database: str | None = None):
        self.server, self.database = server or settings.sql_server, database or settings.sql_database
        if not self.server or not self.database:
            raise RuntimeError("AZURE_SQL_SERVER and AZURE_SQL_DATABASE must be configured.")
        self.settings = settings
        self._token: tuple[bytes, float] | None = None
        self._lock = threading.Lock()
        self._credential = None

    def _access_token(self) -> bytes:
        with self._lock:
            if self._token and self._token[1] - time.time() > 300:
                return self._token[0]
            if self._credential is None:
                from azure.identity import DefaultAzureCredential

                kwargs = {"managed_identity_client_id": self.settings.azure_client_id} if self.settings.azure_client_id else {}
                self._credential = DefaultAzureCredential(**kwargs)
            token = self._credential.get_token(SQL_SCOPE)
            raw = token.token.encode("utf-16-le")
            packed = struct.pack(f"<I{len(raw)}s", len(raw), raw)
            self._token = (packed, float(token.expires_on))
            return packed

    def _connect(self) -> pyodbc.Connection:
        s = self.settings
        conn_str = (
            f"Driver={{{s.sql_odbc_driver}}};Server=tcp:{self.server},1433;Database={self.database};"
            "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=15;"
        )
        return pyodbc.connect(conn_str, attrs_before={SQL_COPT_SS_ACCESS_TOKEN: self._access_token()}, timeout=15)

    @contextmanager
    def connection(self) -> Iterator[pyodbc.Connection]:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def ping(self) -> bool:
        with self.connection() as conn:
            return conn.cursor().execute("SELECT 1").fetchval() == 1
