# Agent-specific Dockerfile using Wolfi base
FROM cgr.dev/chainguard/wolfi-base:latest AS agent

USER root

# Install runtime dependencies (including Node.js for CLI tools and debugging tools)
RUN apk --no-cache --update upgrade && apk --no-cache add \
    python-3.12 \
    bash \
    git \
    ca-certificates \
    openssl \
    nodejs \
    npm \
    curl \
    wget \
    jq \
    vim \
    grep \
    less \
    file \
    gzip \
    coreutils \
    findutils \
    ripgrep

# Create nonroot user and directories
RUN adduser -D -u 1000 agentuser
WORKDIR /app
RUN chown agentuser:agentuser /app

# Create virtual environment
RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:/usr/bin:/bin:/usr/local/bin:$PATH"

# Copy and install minimal Python requirements for agent
COPY agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install AI CLI tools globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Note: Codex requires specific binary locations to execute commands
# Ensure all common commands are available in standard paths
# The --dangerously-bypass-approvals-and-sandbox flag disables sandboxing

# Ensure commands are available in standard locations
RUN which ls cat head tail wc sed find grep || true
RUN ls -la /bin/ /usr/bin/ | grep -E "(ls|cat|head|tail|wc|sed|find|grep)" || true

# Copy agent code only
COPY --chown=agentuser:agentuser agent/ ./agent/
COPY --chown=agentuser:agentuser app/models/ ./app/models/
COPY --chown=agentuser:agentuser app/core/config.py ./app/core/config.py

# Switch to nonroot user
USER agentuser

# Set working directory to workspace
WORKDIR /workspace

# Add /app to Python path so agent imports work
ENV PYTHONPATH="/app:$PYTHONPATH"

# Run agent
CMD ["python", "-m", "agent.main"]