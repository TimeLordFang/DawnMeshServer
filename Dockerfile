FROM golang:1.25.7-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dawnmesh-server ./cmd/dawnmesh-server

FROM alpine:3.23.3
RUN addgroup -S dawnmesh && adduser -S -G dawnmesh dawnmesh && mkdir /data && chown dawnmesh:dawnmesh /data
COPY --from=build /out/dawnmesh-server /usr/local/bin/dawnmesh-server
USER dawnmesh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dawnmesh-server"]

