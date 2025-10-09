# CI-Server Documentation

This directory contains comprehensive documentation for the CI-Server project, organized by topic area.

## Database Documentation

The database documentation is organized into three main sections:

### Architecture (`database-architecture.md`)
High-level architectural overview including:
- Domain organization (8 domains, 21 entities)
- Key architectural patterns (user-centric design, domain-driven design, etc.)
- Core relationships between entities
- Technology stack integration
- Data flow overview

### Design (`database-design.md`)
Detailed technical specifications including:
- Entity definitions and SQL schemas
- Data types and constraints
- Join table patterns
- Index strategies
- TimescaleDB and vector search integration
- Schema evolution support

### Usage (`database-usage.md`)
Practical usage guidance including:
- Getting started patterns
- Core usage examples with TypeScript/TypeORM
- Best practices for performance and data integrity
- Common query patterns
- Troubleshooting guide

## Visual Diagrams

### UML Diagrams
- `database-schema.puml` - PlantUML source file for generating professional UML diagrams
- `database-diagrams.md` - GitHub-renderable Mermaid ER diagrams
- `database-text-diagrams.md` - ASCII art diagrams for text-only environments

## Quick Start

1. **New developers**: Start with `database-architecture.md` for an overview
2. **Database work**: Reference `database-design.md` for technical details
3. **Implementation**: Use `database-usage.md` for practical examples
4. **Visualization**: View `database-diagrams.md` in GitHub for interactive diagrams

## Maintenance

This documentation should be updated whenever:
- New entities are added to the database
- Existing entity schemas are modified
- New domains or architectural patterns are introduced
- Migration files add new features or constraints

All documentation reflects the current state of the database schema including recent updates for PGBoss job queues, TimescaleDB optimization, and enhanced AI conversation support.