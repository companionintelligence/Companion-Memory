# CI-Server Documentation

This directory contains comprehensive documentation for the CI-Server project, organized by topic area.

*Last updated: Regenerated from current codebase analysis on October 9, 2024*

## Database Documentation

The database documentation has been completely regenerated from the current codebase and is organized into three main sections:

### Architecture (`database-architecture.md`)
High-level architectural overview including:
- Domain organization (8 domains, 21 entities)
- Key architectural patterns (user-centric design, domain-driven design, etc.)
- Core relationships between entities
- Technology stack integration (PostgreSQL, TimescaleDB, PGBoss, pgvector)
- Data flow overview and security considerations

### Design (`database-design.md`)
Detailed technical specifications including:
- Complete entity definitions with SQL schemas and indexes
- Data types, constraints, and foreign key relationships
- Join table patterns for many-to-many relationships
- TimescaleDB hypertable implementation for time-series data
- Vector search integration and external data provenance
- Performance optimization strategies and schema evolution support

### Usage (`database-usage.md`)
Practical usage guidance including:
- Getting started patterns with user onboarding and external integrations
- Comprehensive usage examples with TypeScript/TypeORM code
- Core patterns for memory management, conversations, and AI interactions
- Best practices for performance, data integrity, and security
- Common query patterns and troubleshooting guide
- Health monitoring and performance analysis queries

## Visual Diagrams

### Professional UML Diagrams
- `database-schema.puml` - PlantUML source file for generating professional UML diagrams with domain color-coding and comprehensive annotations

### Interactive GitHub Diagrams
- `database-diagrams.md` - GitHub-renderable Mermaid ER diagrams with complete entity definitions and relationship mappings

### Text-Based Reference
- `database-text-diagrams.md` - ASCII art diagrams and text-based entity listings for text-only environments and quick reference

## Database Schema Overview

The regenerated documentation reflects the current state of a sophisticated schema with:

- **21 main entities** organized across **8 functional domains**
- **10 join tables** for many-to-many relationships
- **Universal tagging system** across all major content entities
- **TimescaleDB hypertable** optimization for high-volume API logging
- **Vector search integration** for AI-powered semantic discovery
- **External data integration** with OAuth2 and comprehensive provenance tracking
- **Background job processing** via dedicated PGBoss schema
- **Complete audit trails** with user-scoped data isolation

## Quick Start Guide

1. **New developers**: Start with `database-architecture.md` for high-level understanding
2. **Database development**: Reference `database-design.md` for technical implementation details
3. **Application development**: Use `database-usage.md` for practical TypeORM examples and patterns
4. **Schema visualization**: View `database-diagrams.md` in GitHub for interactive diagrams
5. **Professional documentation**: Generate diagrams from `database-schema.puml` using PlantUML tools

## Key Features Documented

### User-Centric Architecture
- Complete multi-tenant data isolation via user_id scoping
- Comprehensive authentication and session management
- User onboarding workflow with signup codes

### Memory Management System
- Personal contacts and demographics (people, contacts)
- Location tracking with hierarchical places
- Calendar events with time ranges and external integration
- Document and media content with MIME type support
- Physical/digital item tracking linked to events

### AI-Powered Intelligence
- Question-answer knowledge base with categorization
- RAG (Retrieval-Augmented Generation) and user-provided responses
- Action tracking linked to conversation context
- Vector embeddings for semantic search across all content types

### Conversation System
- Thread-based conversations with AI models
- Role-based message flow (user, assistant, system)
- Tool call support for AI function execution
- File attachments and soft delete preservation

### External Integration
- OAuth2-enabled connections to external services
- Comprehensive data provenance tracking
- High-volume API logging with TimescaleDB optimization
- Synchronization state management

### Background Processing
- PGBoss job queue system with dedicated schema
- Automatic retry and scheduling capabilities
- Operational isolation from main application data

## Maintenance Guidelines

This documentation should be updated whenever:
- New entities are added to the database schema
- Existing entity relationships or constraints are modified
- New domains or architectural patterns are introduced
- Migration files introduce significant structural changes
- Performance optimization strategies are implemented

The documentation is generated from the current codebase state and includes:
- Fresh analysis of all 21 TypeORM entities
- Complete migration history examination
- Current relationship mapping and constraint validation
- Up-to-date technology stack integration details

All documentation reflects the production-ready schema including recent updates for PGBoss job queues, TimescaleDB optimization, enhanced AI conversation support, and streamlined OAuth2 implementation.