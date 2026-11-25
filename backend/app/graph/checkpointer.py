import asyncio
from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, CheckpointTuple
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg_pool import ConnectionPool

from app.core.config import get_settings


class AsyncCompatiblePostgresSaver(PostgresSaver):
    """
    Production PostgreSQL checkpointer that works natively on BOTH Windows (ProactorEventLoop)
    and Linux cloud deployments by running psycopg3 pool operations via asyncio.to_thread.
    """

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await asyncio.to_thread(self.get_tuple, config)

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: dict[str, Any],
    ) -> RunnableConfig:
        return await asyncio.to_thread(self.put, config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        await asyncio.to_thread(self.put_writes, config, writes, task_id, task_path)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        items = await asyncio.to_thread(lambda: list(self.list(config, filter=filter, before=before, limit=limit)))
        for item in items:
            yield item

    async def adelete_thread(self, thread_id: str) -> None:
        await asyncio.to_thread(self.delete_thread, thread_id)


class CheckpointerManager:
    """Manages the PostgreSQL psycopg connection pool and LangGraph checkpoint tables."""

    def __init__(self) -> None:
        self._pool: ConnectionPool | None = None
        self._saver: AsyncCompatiblePostgresSaver | None = None

    def get_saver(self) -> AsyncCompatiblePostgresSaver:
        if self._saver is None:
            settings = get_settings()
            self._pool = ConnectionPool(
                conninfo=settings.CHECKPOINT_DATABASE_URL,
                min_size=1,
                max_size=10,
                open=True,
                kwargs={},
            )
            self._saver = AsyncCompatiblePostgresSaver(self._pool)
            self._saver.setup()
        return self._saver

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()
            self._pool = None
            self._saver = None


checkpointer_manager = CheckpointerManager()
