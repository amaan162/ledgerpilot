-- Runs automatically once when the PostgreSQL container initializes.
-- Enables pgvector for Contract RAG embeddings and uuid-ossp for UUIDs.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";