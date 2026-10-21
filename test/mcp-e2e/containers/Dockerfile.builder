# vscode-mcp-build:2 - the builder/runtime image for the VS Code fork end-to-end tests.
# Extends vscode-mcp-build:latest (Ubuntu 24.04, build-essential, X11/GTK/NSS, xvfb,
# Node 24 from NodeSource, Zig 0.16.0) with what the Linux packaging tasks and the
# e2e checks need.
#
#   wslc build -t vscode-mcp-build:2 -f Dockerfile.builder <this folder>
FROM vscode-mcp-build:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
		fakeroot dpkg-dev rpm file xz-utils \
		libkrb5-dev libxkbfile-dev libsecret-1-dev \
		bubblewrap socat procps iproute2 netcat-openbsd dnsutils \
		libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
		libcups2t64 libpango-1.0-0 libcairo2 libdrm2 libdbus-1-3 dbus-x11 \
	&& rm -rf /var/lib/apt/lists/*

# The base image sets ELECTRON_SKIP_BINARY_DOWNLOAD=1; the desktop build needs Electron.
# An empty value is falsy for every consumer (they test the variable for truthiness),
# build-vscode.sh additionally unsets it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=

WORKDIR /work
CMD ["bash"]
