# Database Architecture Redesign

This document outlines the comprehensive database architecture improvements implemented to enhance performance, data integrity, and maintainability.

## Overview

The database redesign addresses several critical architectural issues:
- Missing performance indexes on foreign key relationships
- Inconsistent data type usage and validation
- Suboptimal vector storage for embeddings
- Type safety issues in TypeORM entities

## Key Improvements

### 1. Performance Indexing Strategy

**Migration**: `20250831201209_add_performance_indexes.sql`

Added comprehensive indexing for optimal query performance:

#### Foreign Key Indexes
- All foreign key columns now have indexes for efficient joins
- Examples: `user_id`, `thread_id`, `connection_id`, `provider_id`

#### Composite Indexes
- User-centric queries: `(user_id, created_at DESC)`
- Thread message ordering: `(thread_id, created_at DESC)`

#### JSONB Indexes
- GIN indexes for all JSONB columns (`source_data`, `tool_calls`, etc.)
- Enables efficient querying of JSON content

#### Partial Indexes
- External ID indexes with null conditions for API integration
- Format: `WHERE external_id IS NOT NULL`

### 2. Data Constraints & Validation

**Migration**: `20250831201210_add_data_constraints.sql`

Enhanced data integrity through constraints:

#### CHECK Constraints
- Type field validation (length limits)
- Email format validation for users
- URL format validation for source URLs and avatars
- Gender enumeration for people
- MIME type format validation
- Time logical consistency (start_time <= end_time)

#### Unique Constraints
- External ID uniqueness within user context
- Prevents duplicate external references per user

### 3. pgvector Optimization

**Migration**: `20250831201211_optimize_embeddings_for_pgvector.sql`

Optimized vector storage and similarity search:

#### Native Vector Column
- Added `embedding_vector_native` as proper vector type
- Maintains backward compatibility with existing text-based storage

#### Vector Indexes
- HNSW indexes for cosine and L2 similarity search
- Dramatically improves vector query performance

#### Utility Functions
- Conversion function for text-to-vector migration
- Helper methods in entity for vector operations

### 4. Entity Type Safety

Improved TypeScript type safety across entities:

#### MessageRole System
- Strict type definition: `'user' | 'assistant' | 'system' | 'tool'`
- Consistent usage across entities, DTOs, and services
- Proper fallback logic for legacy data

#### Column Type Optimization
- VARCHAR with appropriate length limits vs TEXT
- Proper nullable field handling
- Required relationship enforcement

## Performance Impact

### Before Redesign
- 56+ foreign key relationships without indexes
- Only 4 indexes total for performance
- Full table scans for user-centric queries
- Inefficient vector similarity searches

### After Redesign
- 50+ critical performance indexes
- Composite indexes for common query patterns
- GIN indexes for JSON querying
- HNSW indexes for vector similarity
- Partial indexes for conditional lookups

### Expected Improvements
- 10-100x faster user-centric queries
- Sub-second vector similarity searches
- Efficient JSON field querying
- Reduced database load under concurrent access

## Migration Strategy

### Backward Compatibility
- All migrations use `CONCURRENTLY` for zero-downtime index creation
- Legacy vector storage maintained alongside new format
- Graceful type conversion with fallback logic

### Rollback Support
- Complete rollback scripts for all changes
- Safe to revert individual migrations
- No data loss during migration or rollback

## Usage Examples

### Vector Similarity Search
```typescript
// Use the new native vector column for similarity search
const similarEmbeddings = await embeddingRepository
  .createQueryBuilder('e')
  .where('e.user_id = :userId', { userId })
  .orderBy('e.embedding_vector_native <-> :vector', 'ASC')
  .setParameters({ vector: '[0.1, 0.2, 0.3]' })
  .limit(10)
  .getMany();
```

### Message Role Validation
```typescript
// Type-safe message creation
const message: CreateMessageDto = {
  threadId: threadId,
  role: 'user', // TypeScript ensures valid role
  content: 'Hello, world!',
  model: 'gemma3:1b'
};
```

### Indexed Query Patterns
```sql
-- Fast user message lookup (uses composite index)
SELECT * FROM messages 
WHERE user_id = $1 AND thread_id = $2 
ORDER BY created_at DESC;

-- Efficient JSON querying (uses GIN index)
SELECT * FROM events 
WHERE source_data @> '{"type": "meeting"}';
```

## Monitoring & Maintenance

### Index Usage Monitoring
```sql
-- Check index usage statistics
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### Vector Performance Monitoring
```sql
-- Monitor vector similarity query performance
SELECT * FROM embedding_similarities 
WHERE user_id = $1 
ORDER BY embedding_vector_native <-> $2
LIMIT 10;
```

### Constraint Violations
- Monitor application logs for constraint violation errors
- Indicates data quality issues that need addressing
- Use violations as input for further schema improvements

## Future Considerations

### Additional Optimizations
- Consider partitioning large tables by user_id
- Add materialized views for complex aggregations
- Implement query result caching for frequent patterns

### Schema Evolution
- Add new constraints based on data patterns
- Optimize vector dimensions based on model usage
- Consider additional composite indexes for new query patterns

### Monitoring
- Set up query performance monitoring
- Track index usage and effectiveness
- Monitor constraint violation rates

## Testing

Comprehensive tests ensure the redesign maintains functionality:
- Entity type safety validation
- Vector storage and conversion testing
- Constraint validation testing
- Backward compatibility verification

All existing functionality is preserved while gaining significant performance and reliability improvements.