"""
Database connection and utilities for CI-Memory agent.
"""
import structlog
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

from .config import settings

logger = structlog.get_logger()


class DatabaseManager:
    """Manages database connections and queries."""
    
    def __init__(self):
        self.engine: Optional[Engine] = None
        self._connect()
    
    def _connect(self):
        """Establish database connection."""
        try:
            self.engine = create_engine(
                settings.database_url,
                poolclass=NullPool,  # Simple connection management
                echo=False,
                connect_args={"options": "-c search_path=ci,public"},
            )
            logger.info("database_connected", url=settings.database_url.split('@')[1] if '@' in settings.database_url else 'localhost')
        except Exception as e:
            logger.error("database_connection_failed", error=str(e))
            raise
    
    def execute_query(self, query: str, params: Optional[Dict[str, Any]] = None) -> List[Dict]:
        """Execute a query and return results as list of dicts."""
        try:
            with self.engine.connect() as conn:
                result = conn.execute(text(query), params or {})
                
                # Handle queries that don't return results
                if result.returns_rows:
                    columns = result.keys()
                    return [dict(zip(columns, row)) for row in result.fetchall()]
                return []
                
        except Exception as e:
            logger.error("query_execution_failed", query=query[:100], error=str(e))
            raise
    
    def execute_write(self, query: str, params: Optional[Dict[str, Any]] = None):
        """Execute a write query (INSERT, UPDATE, DELETE)."""
        try:
            with self.engine.connect() as conn:
                conn.execute(text(query), params or {})
                conn.commit()
        except Exception as e:
            logger.error("write_execution_failed", query=query[:100], error=str(e))
            raise
    
    def close(self):
        """Close database connection."""
        if self.engine:
            self.engine.dispose()
            logger.info("database_connection_closed")


# Global database instance
db = DatabaseManager()
