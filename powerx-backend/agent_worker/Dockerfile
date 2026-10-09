# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — packages the WormGPT in-sandbox agent worker (agent.py) into a
# container image that runs INSIDE the user's persistent Daytona sandbox.
#
# This is the "agent owns the computer" image from the design: a long-running
# agent.py loop that watches the inbox, plans, and executes tools locally. The
# host controller builds this image inside the sandbox (via podman) and runs it
# detached with the work dir bind-mounted so files persist on the sandbox disk.
#
# Kept deliberately minimal (stdlib-only agent) for fast, reliable builds on the
# stock Daytona image. Heavy libs are installed on demand by the agent itself.
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim

# Common CLI tools the agent reaches for (git/curl/zip/etc.). Best-effort.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
       bash git curl wget zip unzip ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_WORK=/home/daytona/work \
    PYTHONUNBUFFERED=1

WORKDIR /home/daytona/agent

COPY agent.py /home/daytona/agent/agent.py
COPY requirements.txt /home/daytona/agent/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt || true

# The work dir is bind-mounted from the sandbox at run time so deliverables and
# the inbox/outbox live on the persistent sandbox disk.
VOLUME ["/home/daytona/work"]

CMD ["python", "agent.py"]
