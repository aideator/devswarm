# AIdeator Architecture

## System Overview

AIdeator is a Kubernetes-native LLM orchestration platform that runs multiple AI agents in isolated containers, streaming their thought processes in real-time via WebSocket + Redis Streams with dual-write persistence.

```
┌─────────────────┐    WebSocket    ┌─────────────────┐   Redis Streams    ┌─────────────────┐
│   Next.js       │ ◀─────────────▶ │   FastAPI       │ ◀─────────────────▶│  Kubernetes     │
│   Frontend      │                 │   Backend       │                    │  Agent Jobs     │
│   (Port 3000)   │                 │   (Port 8000)   │                    │  (Dual Write)   │
└─────────────────┘                 └─────────────────┘                    └─────────────────┘
                                            │                                       │
                                            ▼                                       ▼
                                    ┌─────────────────┐                    ┌─────────────────┐
                                    │     Redis       │                    │   PostgreSQL    │
                                    │   Streams       │                    │   Database      │
                                    │   (Port 6379)   │                    │   (Persistence) │
                                    └─────────────────┘                    └─────────────────┘
```

## Tech Stack

### Frontend
- **Next.js 15.2.4** - React 19 framework with App Router and Turbopack
- **React 19.0.0** - Latest React with improved performance
- **TypeScript 5** - Type-safe JavaScript with latest features
- **Tailwind CSS v4.1.11** - Utility-first CSS with PostCSS v4
- **WebSocket** - Real-time bidirectional streaming with native browser API

### Backend
- **FastAPI** - Modern async web framework with automatic OpenAPI
- **SQLite + SQLModel** - Lightweight database with async ORM
- **Pydantic** - Data validation and serialization
- **Kubernetes Jobs** - Isolated agent execution with automatic cleanup
- **Redis Streams** - Persistent message streams for real-time data
- **PostgreSQL** - Persistent database for agent outputs and run history

### Infrastructure
- **Kubernetes** - Container orchestration and job management
- **Helm Charts** - Package manager for Kubernetes applications
- **Tilt** - Local Kubernetes development environment
- **k3d** - Lightweight local Kubernetes clusters
- **Local Registry** - Fast container iteration at localhost:5005

## Key Components

### Directory Structure

```
frontend/                  # Next.js application
├── app/                   # Next.js 15 App Router
│   ├── page.tsx          # Homepage with feature showcase
│   ├── stream/page.tsx   # Multi-agent streaming interface
│   └── globals.css       # Tailwind CSS v4 + design system
├── components/
│   ├── agents/           # Agent-specific components
│   │   ├── StreamCard.tsx
│   │   └── StreamGrid.tsx
│   ├── ui/               # shadcn/ui components
│   └── layout/           # Layout components
├── hooks/
│   └── useAgentStream.ts # SSE streaming hook
└── lib/
    └── api.ts            # FastAPI client

app/                      # FastAPI backend
├── api/v1/              # API endpoints
├── services/            # Business logic
│   ├── kubernetes_service.py    # Job orchestration
│   ├── agent_orchestrator.py   # Multi-agent management
│   └── redis_service.py        # Pub/sub messaging
└── main.py              # Application entry

deploy/
├── charts/aideator/     # Helm chart
└── values/              # Environment configs
```

## Kubernetes Architecture

### Native Integration
- **Pods & Jobs**: Each agent runs as a Kubernetes Job
- **Service Accounts**: RBAC for kubectl operations
- **ConfigMaps & Secrets**: Configuration and API key management
- **Local Registry**: Development with localhost:5005
- **Tilt**: Streamlined local development workflow

### Key Workflows

1. **Job Submission** → Create Kubernetes Job → Agent container execution
2. **Real-time Streaming** → Agent publishes to Redis → Backend subscribes → SSE to client
3. **Job Management** → Status tracking → TTL cleanup → Resource limits
4. **Development** → Tilt up → Hot reload → Port forwarding (automatic)

### Implementation Example

```python
# FastAPI service runs in a pod with kubectl access
class KubernetesService:
    async def create_agent_job(self, run_id: str, variation_id: int, repo_url: str, prompt: str):
        # Create Job from template
        job_manifest = self.render_job_template(
            run_id=run_id,
            variation_id=variation_id,
            repo_url=repo_url,
            prompt=prompt
        )
        
        # Apply via kubectl
        subprocess.run(["kubectl", "apply", "-f", "-"], input=job_manifest)
        
    async def monitor_job_status(self, job_name: str) -> dict:
        # Monitor job status via kubectl
        process = await asyncio.create_subprocess_exec(
            "kubectl", "get", "job", job_name, "-o", "json",
            stdout=asyncio.subprocess.PIPE
        )
        
        stdout, _ = await process.communicate()
        return json.loads(stdout.decode())
```

## Design System

AIdeator uses a custom design system optimized for multi-agent interfaces:

### Color Palette
- **AI Primary** (`#4f46e5`): Main actions and branding
- **Agent Colors**: Red, Amber, Emerald, Blue, Purple (for 5 agents)
- **Neutral Palette**: White, Paper, Fog, Shadow, Charcoal

### Component Patterns
- **Agent Stream Cards**: Color-coded with status indicators
- **Responsive Grid**: 1-5 columns based on screen size
- **Real-time Animations**: Pulse indicators and shimmer loading

### Typography
- **Display** (48px): Hero titles
- **H1-H3**: Page and section headers
- **Body**: 16px default with Large (18px) and Small (14px) variants

## Security

### Kubernetes Security
- **RBAC**: Service account with minimal permissions
- **Secrets**: API keys stored as Kubernetes Secrets
- **Resource Limits**: Memory and CPU limits on all containers
- **Security Contexts**: Non-root users, read-only filesystems where possible

### Required Secrets
```bash
# 1. OpenAI API key (for LiteLLM)
kubectl create secret generic openai-secret \
  --from-literal=api-key="$OPENAI_API_KEY" \
  -n aideator

# 2. Application secret key
kubectl create secret generic aideator-secret \
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  -n aideator
```

## Streaming Architecture

### LiteLLM Integration
```python
# Agent uses LiteLLM with streaming for real-time output
async for chunk in await acompletion(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": prompt}],
    stream=True  # Enable streaming
):
    if chunk.choices and chunk.choices[0].delta.content:
        chunk_text = chunk.choices[0].delta.content
        # Publish to Redis for streaming
        await redis_client.publish(f"run:{run_id}:output:{variation_id}", chunk_text)
```

### Streaming Pipeline
1. Agent publishes output to Redis channels
2. Backend subscribes to Redis pub/sub
3. Messages converted to Server-Sent Events
4. Frontend receives and displays in real-time
5. Redis handles reconnection and buffering

## Development Patterns

### Smart Template Fallback
The agent-job.yaml Helm template uses defaults for easy testing:

```yaml
env:
  - name: REPO_URL
    value: "{{ .Values.repoUrl | default "https://github.com/octocat/Hello-World" }}"
  - name: PROMPT  
    value: "{{ .Values.prompt | default "Analyze this repository and describe what it does" }}"
```

Benefits:
- Development: Job runs immediately with sensible defaults
- Production: KubernetesService overrides with real values
- Single Template: No duplication between dev and prod
- Always Testable: Agent changes can be tested without the full API

## Streaming Architecture: Dual-Write Pattern

### Overview

AIdeator uses a **dual-write pattern** where agents simultaneously write to both Redis Streams (for real-time) and PostgreSQL (for persistence), ensuring both immediate responsiveness and long-term data integrity.

### Flow Diagram

```
┌──────────────────┐     ┌─────────────────┐     ┌────────────────┐
│   Agent (K8s)    │────▶│  Dual Write     │────▶│   Real-time    │
│                  │     │                 │     │                │
│ • LLM Output     │     │ 1. Redis XADD   │     │ • WebSocket    │
│ • Debug Logs     │     │ 2. PostgreSQL   │     │ • Frontend     │
│ • Status Updates │     │    INSERT       │     │ • Live Updates │
└──────────────────┘     └─────────────────┘     └────────────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │  Persistence   │
                         │                │
                         │ • agent_outputs│
                         │ • Query API    │
                         │ • Historical   │
                         └────────────────┘
```

### Data Flow Details

**1. Agent Output Generation**
```python
# Agent writes to both systems atomically
async def log_output(self, content: str, output_type: str = "llm"):
    timestamp = datetime.utcnow()
    
    # Real-time: Redis Streams
    await self.redis_client.xadd(
        f"run:{self.run_id}:llm", 
        {
            "variation_id": str(self.variation_id),
            "content": content,
            "timestamp": timestamp.isoformat(),
            "output_type": output_type
        }
    )
    
    # Persistence: PostgreSQL
    output = AgentOutput(
        run_id=self.run_id,
        variation_id=self.variation_id,
        content=content,
        output_type=output_type,
        timestamp=timestamp
    )
    await self.db_session.merge(output)
```

**2. Backend WebSocket Streaming**
```python
# WebSocket endpoint streams from Redis
async for message in redis_service.read_run_streams(run_id, last_ids):
    await websocket.send_json({
        "type": message["type"],
        "message_id": message["message_id"], 
        "data": message["data"]
    })
```

**3. Frontend Tabbed Interface**
```typescript
// Frontend handles messages by variation_id
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.type === 'llm') {
    updateAgentTab(message.data.variation_id, message.data.content)
  }
}
```

### Benefits of Dual-Write

1. **Guaranteed Consistency**: Both writes happen in agent transaction
2. **Zero Data Loss**: Agent failure affects both systems equally  
3. **Real-time Performance**: Redis provides sub-100ms latency
4. **Historical Access**: PostgreSQL enables complex queries and analysis
5. **Simple Architecture**: No background jobs or eventual consistency issues

### Stream Patterns

- **Real-time Streams**: `run:{run_id}:llm`, `run:{run_id}:stdout`, `run:{run_id}:status`
- **Message Format**: `{variation_id, content, timestamp, output_type, metadata}`
- **WebSocket Types**: `connected`, `llm`, `stdout`, `status`, `control_ack`, `error`, `pong`

## Key Advantages

1. **Native Integration**: Uses standard Kubernetes APIs and tooling
2. **Observability**: Full visibility through kubectl and Kubernetes events  
3. **Scalability**: Leverages Kubernetes scheduling and resource management
4. **Portability**: Runs on any Kubernetes cluster (local, cloud, on-prem)
5. **Security**: Built-in RBAC, network policies, and secrets management
6. **Developer Experience**: Tilt provides excellent local development workflow
7. **Real-time + Persistence**: Dual-write pattern ensures both speed and durability