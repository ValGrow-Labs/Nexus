# ml-python: the machine learning kit (the Python sandbox of a Machine learning project's helper and runs). The same pinned base as
# sde-python (digest written by tools/nexus-lock-images.cjs, which reuses sde-python's), the ML packages and the Python kit's tools
# from a hash-pinned lockfile (wheels only, compiled manylinux wheels allowed, no dependency resolution at build time, no network
# at run time), a non-root user (10001), the Nexus entry. Charts work headless: matplotlib uses the Agg backend and keeps its
# cache in /tmp (a writable tmpfs in every Nexus container). The build self-test fails unless the nexus.versions label names
# exactly the installed python and main packages, and every package imports with no display.
FROM docker.io/library/python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
ARG NEXUS_VERSIONS="python=3.11.17 numpy=2.4.6 scipy=1.17.1 pandas=3.1.0 scikit-learn=1.9.1 matplotlib=3.11.2 seaborn=0.13.2 openpyxl=3.1.5 pyarrow=26.0.0 joblib=1.6.0 pytest=9.2.0 build=1.6.1 wheel=0.48.0 setuptools=84.2.1"
LABEL nexus.versions="$NEXUS_VERSIONS"
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib
COPY ml-python/requirements.lock /opt/nexus/requirements.lock
RUN python -m pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary=:all: \
      -r /opt/nexus/requirements.lock \
 && python -m pip check \
 && got="$(python -c 'import importlib.metadata as m, platform; names = "numpy scipy pandas scikit-learn matplotlib seaborn openpyxl pyarrow joblib pytest build wheel setuptools".split(); print(" ".join(["python=" + platform.python_version()] + [n + "=" + m.version(n) for n in names]))')" \
 && if [ "$got" != "$NEXUS_VERSIONS" ]; then echo "nexus.versions ($NEXUS_VERSIONS) does not name exactly what is installed ($got)" >&2; exit 1; fi \
 && python -c 'import numpy, scipy, pandas, sklearn, seaborn, openpyxl, pyarrow, pyarrow.parquet, joblib, pytest, matplotlib, matplotlib.pyplot; assert matplotlib.get_backend().lower() == "agg", matplotlib.get_backend()' \
 && python -m pytest --version \
 && rm -rf /tmp/matplotlib
COPY common/nexus-entry /opt/nexus/nexus-entry
RUN chmod 0755 /opt/nexus/nexus-entry \
 && groupadd -g 10001 nexus && useradd -u 10001 -g 10001 -d /home/nexus -M -s /usr/sbin/nologin nexus \
 && mkdir -p /workspace /home/nexus \
 && chown -R 10001:10001 /workspace /home/nexus
USER 10001:10001
WORKDIR /workspace
HEALTHCHECK NONE
ENTRYPOINT ["/opt/nexus/nexus-entry"]
