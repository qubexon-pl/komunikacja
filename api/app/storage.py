"""Private photo storage: Azure Data Lake Storage Gen2 in Azure, a local folder in development.

Uploads are resumable: the client sends chunks at explicit offsets, the server appends them and records how many
bytes arrived (dbo.TripPhoto.received_bytes); after a dropped connection the client asks for that number and continues.
ADLS keeps appended-but-unflushed data, and the file becomes readable only after the final flush.
Access to ADLS uses the app's Managed Identity (role: Storage Blob Data Contributor on the file system) — no keys.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator, Protocol

from .config import Settings


class PhotoStorage(Protocol):
    def create(self, path: str) -> None: ...
    def append(self, path: str, offset: int, data: bytes) -> None: ...
    def flush(self, path: str, total: int) -> None: ...
    def read(self, path: str) -> Iterator[bytes]: ...
    def delete(self, path: str) -> None: ...


class LocalStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _file(self, path: str) -> Path:
        target = (self.root / path).resolve()
        if self.root not in target.parents:
            raise ValueError("bad photo path")
        return target

    def create(self, path: str) -> None:
        f = self._file(path)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"")

    def append(self, path: str, offset: int, data: bytes) -> None:
        with open(self._file(path), "r+b") as fh:
            fh.seek(offset)
            fh.write(data)
            fh.truncate(offset + len(data))

    def flush(self, path: str, total: int) -> None:
        if self._file(path).stat().st_size != total:
            raise ValueError("size mismatch")

    def read(self, path: str) -> Iterator[bytes]:
        with open(self._file(path), "rb") as fh:
            while chunk := fh.read(256 * 1024):
                yield chunk

    def delete(self, path: str) -> None:
        try:
            os.remove(self._file(path))
        except FileNotFoundError:
            pass


class AdlsStorage:
    def __init__(self, settings: Settings):
        from azure.identity import DefaultAzureCredential
        from azure.storage.filedatalake import DataLakeServiceClient

        kwargs = {"managed_identity_client_id": settings.azure_client_id} if settings.azure_client_id else {}
        service = DataLakeServiceClient(account_url=settings.adls_account_url, credential=DefaultAzureCredential(**kwargs))
        self.fs = service.get_file_system_client(settings.adls_file_system)

    def create(self, path: str) -> None:
        self.fs.get_file_client(path).create_file()

    def append(self, path: str, offset: int, data: bytes) -> None:
        self.fs.get_file_client(path).append_data(data, offset=offset, length=len(data))

    def flush(self, path: str, total: int) -> None:
        self.fs.get_file_client(path).flush_data(total)

    def read(self, path: str) -> Iterator[bytes]:
        yield from self.fs.get_file_client(path).download_file().chunks()

    def delete(self, path: str) -> None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            self.fs.get_file_client(path).delete_file()
        except ResourceNotFoundError:
            pass


def create_storage(settings: Settings) -> PhotoStorage:
    if settings.photo_storage == "adls":
        if not settings.adls_account_url:
            raise RuntimeError("PHOTO_STORAGE=adls needs ADLS_ACCOUNT_URL (https://<account>.dfs.core.windows.net).")
        return AdlsStorage(settings)
    return LocalStorage(settings.local_photo_dir)
