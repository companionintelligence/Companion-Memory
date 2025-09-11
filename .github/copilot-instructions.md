# CI-Server Development Instructions

**ALWAYS follow these instructions first and fallback to additional search and context gathering only if the information here is incomplete or found to be in error.**

## Repository Overview

CI-Server is a Yarn workspace monorepo with NestJS backend and React frontend for Companion Intelligence. It includes Docker infrastructure, Ollama LLM integration, PostgreSQL with pgvector, and comprehensive build/test workflows.

## Prerequisites Installation

**CRITICAL:** Install prerequisites in this exact order. **NEVER CANCEL** any long-running installations.

### Node.js 22.15.1 (Required)
```bash
# Download and install Node.js 22.15.1 - takes ~3 minutes, NEVER CANCEL
curl -fsSL https://nodejs.org/dist/v22.15.1/node-v22.15.1-linux-x64.tar.xz -o /tmp/node-v22.15.1-linux-x64.tar.xz
cd /tmp && tar -xf node-v22.15.1-linux-x64.tar.xz
sudo cp -r node-v22.15.1-linux-x64/* /usr/local/
# Alternative if permissions fail: install to ~/nodejs and add to PATH
```

### Verify Node.js Version
```bash
node --version  # Must output: v22.15.1
```

### Docker (Required)
Ensure Docker is installed and running:
```bash
docker --version  # Must show Docker version 20+
```

### Ollama (Required for LLM Features)
```bash
# Install Ollama - may fail due to firewall limitations
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama daemon
ollama serve &

# Pull required models - takes 5-10 minutes each, NEVER CANCEL
ollama pull nomic-embed-text
ollama pull gemma3:1b

# Verify models installed
ollama list
```

**NOTE:** If Ollama installation fails due to network restrictions, document this limitation in your changes.

### Hostname Configuration
```bash
echo "127.0.0.1 dev.companionintelligence.com" | sudo tee -a /etc/hosts
```

## Project Setup

**NEVER CANCEL** these setup commands. They may take several minutes to complete.

### Initial Setup
```bash
# Enable Corepack and prepare Yarn - takes ~30 seconds
corepack enable
corepack prepare yarn@4.9.1 --activate

# Install dependencies - takes ~2m 12s, NEVER CANCEL
yarn install
# WARNING: Will show peer dependency warnings - these are expected

# Setup VS Code SDKs
yarn dlx @yarnpkg/sdks vscode

# Setup git hooks
yarn prepare
```

### Validate Installation
```bash
# Use provided make command to validate prerequisites
make init
# This checks Node.js version, Ollama status, hostname, and models
```

## Build Process

**CRITICAL:** Set timeouts of 60+ minutes for build commands. **NEVER CANCEL** builds.

### Individual Component Builds
```bash
# Backend API build - takes ~10 seconds
yarn workspace @ci/be-api build

# Frontend web build - takes ~27 seconds  
yarn workspace @ci/fe-web build

# Full application build - takes ~45 seconds for compilation
# Docker builds may take much longer or fail due to network restrictions
make build  # Set timeout to 60+ minutes, NEVER CANCEL
```

## Development Workflow

### Start Infrastructure Services
```bash
# Start Docker infrastructure - takes ~2-3 minutes
make infra

# Start local development services
make local
```

### Database Operations
```bash
# Run migrations - requires working PostgreSQL
make migrate

# Seed database with test data
make seed

# Generate vector embeddings for search
make index
```

### Development Servers

#### Method 1: Using tmux (Recommended)
```bash
# Start both backend and frontend in tmux session
make dev
# This starts backend with pretty logs and frontend dev server
# Backend will retry database connections if DB not ready
```

#### Method 2: Individual Services
```bash
# Backend API server - requires PostgreSQL running
cd backend/apps/api
yarn dev          # Basic logs
yarn dev:pretty   # Pretty-printed logs

# Frontend development server - starts in ~2 seconds
cd frontend/apps/web  
yarn dev          # Starts on http://localhost:5173/

# Storybook for component development - starts in ~3.7 seconds
cd frontend/apps/web
yarn storybook    # Starts on http://localhost:6006/
```

## Testing and Validation

### Code Quality Checks
```bash
# Repository-wide linting - takes ~6 seconds
yarn lint
yarn lint:fix     # Auto-fix issues

# Type checking
yarn workspace @ci/be-api typecheck     # Takes ~4 seconds
yarn workspace @ci/fe-web typecheck     # Takes ~11 seconds
```

### Running Tests
```bash
# Backend API tests - takes ~9 seconds, NEVER CANCEL
yarn workspace @ci/be-api test
# Runs 10 tests, all should pass

# Additional backend checks
yarn workspace @ci/be-api lint:circular-imports
```

### CI Validation
**ALWAYS** run these before committing to ensure CI passes:
```bash
yarn lint                                   # Repository linting
yarn workspace @ci/be-api lint             # Backend linting  
yarn workspace @ci/fe-web lint             # Frontend linting
yarn workspace @ci/be-api typecheck        # Backend type check
yarn workspace @ci/fe-web typecheck        # Frontend type check
yarn workspace @ci/be-api test             # Backend tests
```

## Manual Validation Requirements

**CRITICAL:** After making changes, ALWAYS validate application functionality:

### Backend Validation
1. Start backend dev server: `yarn dev:pretty`
2. Verify API starts without errors (may show DB connection retries)
3. Test API endpoints if database is available

### Frontend Validation  
1. Start frontend dev server: `yarn dev`
2. Access http://localhost:5173/
3. Verify application loads without console errors
4. Test login functionality if backend/database available
5. **ALWAYS** take screenshots of UI changes

### Full Stack Validation
1. Start infrastructure: `make local`
2. Run migrations and seed: `make migrate && make seed`
3. Start development environment: `make dev`
4. Access https://dev.companionintelligence.com
5. Test login with: `jsmith@example.com` / `]60.a6{CJ}lB*rHAp;w;`
6. Execute complete user workflows

## Common Commands Reference

### Make Commands
```bash
make help          # Show all available commands
make init          # Initialize repository after checkout
make local         # Start local Docker services
make dev           # Start development environment with tmux
make build         # Build application and Docker images (60+ min timeout)
make migrate       # Run database migrations
make seed          # Seed database with test data
make index         # Generate search embeddings
make gentoken      # Generate development access token
```

### Workspace Commands
```bash
# Backend (NestJS API)
yarn workspace @ci/be-api <command>

# Frontend (React SPA)  
yarn workspace @ci/fe-web <command>
```

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

## Project Structure

### Backend (`backend/apps/api/`)
- **Entry point:** `src/main.ts`
- **Controllers:** `src/domains/{domain}/controllers/`
- **Services:** `src/domains/{domain}/services/`
- **Entities:** `src/domains/{domain}/entities/`
- **Migrations:** `db/migrations/`
- **Key domains:** auth, llm, memory, intelligence, conversations

### Frontend (`frontend/apps/web/`)
- **Entry point:** `src/main.tsx`
- **Components:** `src/components/`
- **Pages:** `src/pages/`
- **API client:** `src/api/`
- **Styles:** Tailwind CSS

### Shared Packages (`frontend/packages/`)
- **@ci/common:** Shared utilities and components
- **@ci/shadcn:** UI components (avoid modifying directly)
- **@ci/capture:** Camera capture components

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

## Known Limitations

### Network Restrictions
- Ollama installation may fail due to firewall limitations
- Docker builds requiring external downloads will fail
- Document these limitations if encountered

### Development Environment
- Backend requires PostgreSQL to fully function
- Database retries are normal during startup
- Some features require Ollama models to be available

### Build Process
- Docker builds may fail due to external dependencies
- Local compilation always works
- Full application requires infrastructure services

## Important Notes

### Security
- Contains proprietary code - do not distribute
- Sensitive configuration in `.env` file
- Use provided test credentials for development

### Performance
- Build times are measured and documented
- Use appropriate timeouts for all operations
- Never cancel long-running builds or tests

### Git Workflow
- Always run linting before commits
- Husky pre-commit hooks enforce code quality
- Use feature branches for development

## Emergency Troubleshooting

### Dependencies Not Installing
```bash
yarn install --immutable
```

### Build Failures
```bash
yarn workspace @ci/be-api clean && yarn workspace @ci/be-api build
yarn workspace @ci/fe-web clean && yarn workspace @ci/fe-web build
```

### Database Issues
```bash
make dbclear  # Clear database and start fresh
make migrate && make seed
```

### Docker Issues
```bash
docker compose down
docker compose --profile local up -d
```

Always refer to this documentation first before exploring or running additional commands. These instructions are validated and tested to work correctly.