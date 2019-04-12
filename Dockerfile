FROM debian:stretch

MAINTAINER Team Friendo <team-friendo@riseup.net>
LABEL Description="Image for running a signal-boost service overlaid on top of signal-cli."

# ------------------------------------------------------
# --- Install System Dependencies
# ------------------------------------------------------

ENV ARCH "x64"

RUN mkdir -p /usr/share/man/man1
RUN apt-get update -qq
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y \
    apt-transport-https \
    build-essential \
    curl \
    git \
    gnupg \
    procps \
    pkg-config \
    python \
    xz-utils \
    wget

# ------------------------------------------------------
# --- Install, Configure Supervisord (Golang version)
# ------------------------------------------------------
# see: https://github.com/ochinchina/supervisord

# Copy supervisord binary from Dockerhub
COPY --from=ochinchina/supervisord:latest /usr/local/bin/supervisord /usr/local/bin/supervisord

# ------------------------------------------------------
# --- Install Node.js
# ------------------------------------------------------

ENV NODE_VERSION 8.15.0
ENV YARN_VERSION 1.12.3

RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

# whitelist release signing keys
# node release keys listed at: https://github.com/nodejs/node#release-keys
# yarn release key (6A010c516)listed... where?

RUN set -ex \
  && for key in \
    94AE36675C464D64BAFA68DD7434390BDBE9B9C5 \
    FD3A5288F042B6850C66B31F09FE44734EB7990E \
    71DCFD284A79C3B38668286BC97EC7A07EDE3FC1 \
    DD8F2338BAE7501E3DD5AC78C273792F7D83545D \
    C4F0DFFF4E8C1A8236409D08E73BC641CC11F4C8 \
    B9AE9905FFD7803F25714661B63B535A4C206CA9 \
    77984A986EBC2AA786BC0F66B01FBB92821C587A \
    8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600 \
    4ED778F539E3634C779C87C6D7062848A1AB005C \
    A48C2BEE680E841632CD4E44F07496B3EB3C1762 \
    B9E2F5981AA6E0CD28160D9FF13993A75599653C \
    6A010C5166006599AA17F08146C2130DFD2497F5 \
  ; do \
    gpg --batch --keyserver hkp://p80.pool.sks-keyservers.net:80 --recv-keys "$key" || \
    gpg --batch --keyserver hkp://ipv4.pool.sks-keyservers.net --recv-keys "$key" || \
    gpg --batch --keyserver hkp://pgp.mit.edu:80 --recv-keys "$key" ; \
  done

# retrieve node
RUN set -ex \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" \
  && gpg --batch --decrypt --output SHASUMS256.txt SHASUMS256.txt.asc \
  && grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
  && tar -xJf "node-v$NODE_VERSION-linux-$ARCH.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
  && rm "node-v$NODE_VERSION-linux-$ARCH.tar.xz" SHASUMS256.txt.asc SHASUMS256.txt \
  && ln -s /usr/local/bin/node /usr/local/bin/nodejs

# retrieve yarn
RUN set -ex \
    && curl -fsSLO --compressed "https://yarnpkg.com/downloads/$YARN_VERSION/yarn-v$YARN_VERSION.tar.gz" \
    && curl -fsSLO --compressed "https://yarnpkg.com/downloads/$YARN_VERSION/yarn-v$YARN_VERSION.tar.gz.asc" \
    && gpg --batch --verify yarn-v$YARN_VERSION.tar.gz.asc yarn-v$YARN_VERSION.tar.gz \
    && mkdir -p /opt \
    && tar -xzf yarn-v$YARN_VERSION.tar.gz -C /opt/ \
    && ln -s /opt/yarn-v$YARN_VERSION/bin/yarn /usr/local/bin/yarn \
    && ln -s /opt/yarn-v$YARN_VERSION/bin/yarnpkg /usr/local/bin/yarnpkg \
    && rm yarn-v$YARN_VERSION.tar.gz.asc yarn-v$YARN_VERSION.tar.gz

# ------------------------------------------------------
# --- Install and Configure JVM
# ------------------------------------------------------

RUN DEBIAN_FRONTEND=noninteractive apt-get install -y \
    openjdk-8-jdk-headless

ENV JAVA_HOME "/usr/lib/jvm/java-8-openjdk-amd64"

# ------------------------------------------------------
# --- Install and Configure Signal-Cli
# ------------------------------------------------------

ENV SIGNAL_CLI_VERSION "0.6.2"

# Dependencies
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libpq-dev \
    libunixsocket-java

# Install from repo
RUN wget https://github.com/AsamK/signal-cli/releases/download/v"${SIGNAL_CLI_VERSION}"/signal-cli-"${SIGNAL_CLI_VERSION}".tar.gz; \
    tar xf signal-cli-"${SIGNAL_CLI_VERSION}".tar.gz -C /opt; \
    ln -sf /opt/signal-cli-"${SIGNAL_CLI_VERSION}"/bin/signal-cli /usr/local/bin; \
    rm -rf signal-cli-"${SIGNAL_CLI_VERSION}".tar.gz;

# ------------------------------------------------------
# --- Install and Configure DBus
# ------------------------------------------------------

RUN DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libdbus-1-dev \
    dbus --fix-missing

# Need this to hold the /var/run/dbus/system_bus_socket file descriptor
RUN mkdir -p /var/run/dbus

# ------------------------------------------------------
# --- Configure Environment
# ------------------------------------------------------

WORKDIR /signalboost
