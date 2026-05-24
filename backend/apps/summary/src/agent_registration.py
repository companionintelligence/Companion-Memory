"""
Agent registration in the CI-Server agents table.
"""
import json
import uuid
import structlog
from typing import Optional
from datetime import datetime

from .config import settings
from .database import db

logger = structlog.get_logger()


class AgentRegistration:
    """Handles agent registration and lifecycle in the agents table."""
    
    def __init__(self):
        self.agent_id: Optional[uuid.UUID] = None
    
    def register(self) -> uuid.UUID:
        """
        Register this agent in the agents table.
        Returns the agent_id.
        """
        # Check if agent already exists
        existing_agent = db.execute_query(
            """
            SELECT agent_id, is_active 
            FROM agents 
            WHERE agent_name = :agent_name
            """,
            {"agent_name": settings.agent_name}
        )
        
        if existing_agent:
            self.agent_id = existing_agent[0]['agent_id']
            
            # Update to active if it was inactive
            if not existing_agent[0]['is_active']:
                db.execute_write(
                    """
                    UPDATE agents 
                    SET is_active = true, updated_at = NOW()
                    WHERE agent_id = :agent_id
                    """,
                    {"agent_id": self.agent_id}
                )
                logger.info("agent_reactivated", agent_id=str(self.agent_id))
            else:
                logger.info("agent_already_registered", agent_id=str(self.agent_id))
            
            return self.agent_id
        
        # Create new agent registration
        self.agent_id = uuid.uuid4()
        
        configuration = {
            "type": "temporal_summarization",
            "summarization_levels": ["hourly", "daily", "weekly"],
            "data_sources": [
                "measurements",
                "position", 
                "communications",
                "activities",
                "events",
                "messages",
                "files",
                "api_logs"
            ],
            "llm_config": {
                "model": settings.llm_model,
                "temperature": settings.llm_temperature,
                "max_tokens": settings.llm_max_tokens
            }
        }
        
        input_schema = {
            "type": "object",
            "properties": {
                "task_type": {
                    "type": "string",
                    "enum": ["hourly_summary", "daily_summary", "weekly_summary"]
                },
                "user_id": {
                    "type": "string",
                    "format": "uuid"
                },
                "start_time": {
                    "type": "string",
                    "format": "date-time"
                },
                "end_time": {
                    "type": "string",
                    "format": "date-time"
                }
            },
            "required": ["task_type", "user_id", "start_time", "end_time"]
        }
        
        output_schema = {
            "type": "object",
            "properties": {
                "summary_id": {
                    "type": "string",
                    "format": "uuid"
                },
                "summary_type": {
                    "type": "string"
                },
                "summary_text": {
                    "type": "string"
                },
                "key_insights": {
                    "type": "array",
                    "items": {"type": "string"}
                },
                "activity_counts": {
                    "type": "object"
                }
            }
        }
        
        db.execute_write(
            """
            INSERT INTO agents (
                agent_id, agent_name, agent_type, version, configuration,
                description, input_schema, output_schema, is_active, created_at, updated_at
            ) VALUES (
                :agent_id, :agent_name, :agent_type, :version, CAST(:configuration AS jsonb),
                :description, CAST(:input_schema AS jsonb), CAST(:output_schema AS jsonb), true, NOW(), NOW()
            )
            """,
            {
                "agent_id": str(self.agent_id),
                "agent_name": settings.agent_name,
                "agent_type": "scheduled_task",
                "version": settings.agent_version,
                "configuration": json.dumps(configuration),
                "description": (
                    "Hierarchical temporal summarization agent that creates hourly, daily, "
                    "weekly, and higher-order summaries of user activity across all data sources"
                ),
                "input_schema": json.dumps(input_schema),
                "output_schema": json.dumps(output_schema),
            }
        )
        
        logger.info("agent_registered", 
                   agent_id=str(self.agent_id),
                   agent_name=settings.agent_name,
                   version=settings.agent_version)
        
        return self.agent_id
    
    def deregister(self):
        """Mark agent as inactive (soft delete)."""
        if self.agent_id:
            db.execute_write(
                """
                UPDATE agents 
                SET is_active = false, updated_at = NOW()
                WHERE agent_id = :agent_id
                """,
                {"agent_id": self.agent_id}
            )
            logger.info("agent_deregistered", agent_id=str(self.agent_id))
    
    def update_metrics(self, success: bool, execution_time_ms: int):
        """Update agent performance metrics."""
        if not self.agent_id:
            return
        
        db.execute_write(
            """
            UPDATE agents 
            SET 
                usage_count = usage_count + 1,
                success_count = success_count + CASE WHEN :success THEN 1 ELSE 0 END,
                failure_count = failure_count + CASE WHEN :success THEN 0 ELSE 1 END,
                avg_execution_time_ms = COALESCE(
                    (avg_execution_time_ms * usage_count + :execution_time_ms) / (usage_count + 1),
                    :execution_time_ms
                ),
                updated_at = NOW()
            WHERE agent_id = :agent_id
            """,
            {
                "agent_id": self.agent_id,
                "success": success,
                "execution_time_ms": execution_time_ms
            }
        )


# Global agent registration instance
agent_registration = AgentRegistration()
