# Copilot Instructions for CI-Server

## Project Overview

This is the CI Server repository for Companion Intelligence, a Yarn workspace monorepo containing a NestJS backend API and React frontend. The system integrates with Ollama for LLM capabilities, PostgreSQL for data storage, and includes vector embeddings for AI-powered features.

## Repository Structure

```
├── backend/apps/api/          # NestJS API server with TypeORM, JWT auth, LLM tools
├── frontend/apps/web/         # React + Vite SPA with Tailwind CSS
├── frontend/apps/native/      # Future React Native app
└── frontend/packages/         # Shared packages:
    ├── capture/              # Camera capture components  
    ├── common/               # Shared utilities and components
    ├── shadcn/               # UI components (avoid modifying directly)
    └── template/             # Package template for new packages
```

## Technology Stack

**Backend:**
- NestJS framework with TypeScript
- PostgreSQL database with TypeORM
- JWT authentication with Passport
- Ollama integration for LLMs (nomic-embed-text, gemma3:1b)
- pg-boss for job queuing
- pgvector for vector embeddings
- AWS S3 (via Minio) for file storage

**Frontend:**
- React 19 with TypeScript
- Vite for build tooling
- Tailwind CSS for styling
- React Router for navigation
- ShadCN/UI component library
- Storybook for component development

**DevOps:**
- Docker Compose for local development
- GitHub Actions for CI/CD
- ESLint + Prettier for code quality
- Husky + lint-staged for git hooks

## Development Workflow

### Getting Started
1. Run `make init` to set up the environment
2. Run `make local` to start Docker services  
3. Run `make migrate && make seed` for database setup
4. Run `make dev` to start development servers in tmux

### Key Commands
- `make dev` - Start both backend and frontend in tmux session
- `make build` - Build entire application and Docker images
- `yarn lint` - Run ESLint across the monorepo
- `yarn lint:fix` - Auto-fix linting issues

### Backend Development
- Entry point: `backend/apps/api/src/main.ts`
- Use `yarn dev:pretty` for pretty-printed logs
- Database migrations: `yarn migrate:make <name>`, `yarn migrate`
- LLM tools are in `src/domains/llm/tools/`

### Frontend Development  
- Entry point: `frontend/apps/web/src/main.tsx`
- Use `yarn dev` to start Vite development server
- Components in `src/components/`, pages in `src/pages/`
- Storybook: `yarn storybook`

## Coding Standards

### General Principles
- **Minimal changes**: Make the smallest possible modifications
- **Type safety**: Always use TypeScript properly with strict settings
- **Consistent formatting**: Follow existing ESLint/Prettier configuration
- **No breaking changes**: Preserve existing functionality

### Backend (NestJS) Guidelines
- Use decorators appropriately (`@Injectable()`, `@Controller()`, etc.)
- Follow domain-driven design patterns in `src/domains/`
- Use TypeORM entities for database models
- Implement proper error handling and logging
- Use Zod for validation schemas
- Follow dependency injection patterns

### Frontend (React) Guidelines
- Use function components with hooks
- Follow React 19 best practices
- Use Tailwind CSS classes, avoid custom CSS when possible
- Implement proper loading states and error boundaries
- Use React Router for navigation
- Follow accessibility best practices

### Database Guidelines
- Use TypeORM migrations for schema changes
- Include proper indexes for performance
- Use pgvector for embedding storage
- Follow PostgreSQL naming conventions

## Testing

### Backend Testing
- Jest configuration in `jest.config.mjs`
- E2E tests in `__tests__` directories
- Run tests with `yarn test`
- Test database operations with proper setup/teardown

### Frontend Testing
- Vitest for unit testing
- Testing Library for component tests
- Storybook for visual testing
- Browser testing with Playwright

## File and Directory Conventions

### Backend
- Controllers: `src/domains/{domain}/controllers/`
- Services: `src/domains/{domain}/services/`  
- Entities: `src/domains/{domain}/entities/`
- DTOs: `src/domains/{domain}/dto/`
- Migrations: `db/migrations/`

### Frontend
- Components: `src/components/{category}/`
- Pages: `src/pages/`
- Hooks: `src/hooks/`
- Utils: `src/utils/`
- Types: `src/types/`

## Common Patterns

### Authentication
- JWT tokens with Passport strategies
- Protected routes with guards
- User context throughout the application

### Data Flow
- TypeORM repositories for data access
- NestJS services for business logic
- Controllers for HTTP endpoints
- React hooks for state management

### Error Handling
- NestJS exception filters
- Proper HTTP status codes
- User-friendly error messages in frontend

## AI/LLM Integration

### Ollama Models
- `nomic-embed-text`: For generating embeddings
- `gemma3:1b`: Development LLM model
- Models must be pulled locally: `ollama pull <model>`

### LLM Tools
- Located in `backend/apps/api/src/domains/llm/tools/`
- Currently limited tools for user preferences and family members
- Tools are selectively enabled/disabled

### Vector Search
- Uses pgvector extension
- Embeddings generated via `make index` command
- Search functionality for relevant content

## Local Development Setup

### Prerequisites
- Node.js (version in `.nvmrc`)
- Docker & Docker Compose
- Ollama with required models
- Host entry: `dev.companionintelligence.com → 127.0.0.1`

### Services
- PostgreSQL: Database and job queue
- Minio: S3-compatible file storage  
- NGINX: Reverse proxy
- Backend API: Port varies (check docker-compose)
- Frontend: Port varies (check docker-compose)

## Important Notes

### Security
- This is proprietary software - do not distribute
- Sensitive configuration in `.env` file
- JWT secrets and database credentials are environment-specific

### Performance
- Use database indexes appropriately
- Optimize LLM queries to avoid excessive API calls
- Consider caching for frequently accessed data

### Debugging
- Backend logs via Pino with pretty printing
- Frontend debugging with React DevTools
- Database queries can be logged via TypeORM settings

### Deployment
- Docker images built with `make build`
- Staging environment via `make staging`
- Production deployment follows separate processes

## When Making Changes

1. **Understand the domain**: Identify which part of the system you're modifying
2. **Run existing tests**: Ensure current functionality works
3. **Make minimal changes**: Only modify what's necessary
4. **Test thoroughly**: Verify both unit and integration behavior
5. **Follow conventions**: Match existing patterns and style
6. **Update documentation**: If changing public interfaces

## Common Issues

- **Ollama not running**: Check `ollama serve` is active on port 11434
- **Database connection**: Verify PostgreSQL is running in Docker
- **Module resolution**: Yarn PnP may need `yarn dlx @yarnpkg/sdks vscode`
- **Permission issues**: Ensure Docker has appropriate permissions
- **Host resolution**: Verify `dev.companionintelligence.com` points to localhost

This repository follows modern full-stack development practices with strong typing, comprehensive tooling, and AI integration capabilities.