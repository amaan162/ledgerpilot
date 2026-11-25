from collections.abc import AsyncGenerator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.graph.workflow as workflow_module
from app.core.config import get_settings
from app.db.session import get_db
from app.main import app


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    settings = get_settings()
    test_engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    test_session_factory = async_sessionmaker(
        bind=test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with test_session_factory() as session:
            yield session

    prev_workflow_factory = workflow_module.AsyncSessionLocal
    workflow_module.AsyncSessionLocal = test_session_factory
    app.dependency_overrides[get_db] = _override_get_db

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac
    finally:
        workflow_module.AsyncSessionLocal = prev_workflow_factory
        app.dependency_overrides.clear()
        await test_engine.dispose()
