"""
CI-Memory: Temporal Summarization Agent
Main entry point for the memory summarization service.
"""
import sys
import signal
import structlog

from .config import settings
from .database import db
from .agent_registration import agent_registration
from .summary_worker import worker

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


def signal_handler(sig, frame):
    """Handle shutdown signals gracefully."""
    logger.info("shutdown_signal_received", signal=sig)
    cleanup()
    sys.exit(0)


def cleanup():
    """Cleanup resources on shutdown."""
    logger.info("cleaning_up")
    worker.stop()
    agent_registration.deregister()
    db.close()


def main():
    """Main entry point."""
    logger.info("ci_memory_starting",
               version=settings.agent_version,
               model=settings.llm_model)
    
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    try:
        # Register agent
        agent_id = agent_registration.register()
        logger.info("agent_registered_successfully", agent_id=str(agent_id))
        
        # Start listening for summary jobs
        worker.start()
        
    except Exception as e:
        logger.error("startup_failed", error=str(e))
        cleanup()
        sys.exit(1)


if __name__ == "__main__":
    main()
