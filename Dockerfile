FROM golang:1.27.1-alpine3.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags="-s -w" -o /out/dawnmesh-server ./cmd/dawnmesh-server && \
    mkdir -p /out/data

FROM alpine:3.24.1
COPY --from=build /out/dawnmesh-server /usr/local/bin/dawnmesh-server
COPY --from=build --chown=65532:65532 /out/data /data
LABEL org.opencontainers.image.title="DawnMesh Server" \
      org.opencontainers.image.description="Self-hosted control plane for DawnMesh public intercom rooms" \
      org.opencontainers.image.source="https://github.com/TimeLordFang/DawnMeshServer" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/dawnmesh-server"]
