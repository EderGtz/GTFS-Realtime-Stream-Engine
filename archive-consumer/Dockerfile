FROM golang:1.27-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
# CGO_ENABLED=0 → fully static binary; -s -w strips the
# symbol table. Integration tests are tagged out, so they are not compiled.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /archive-consumer .

FROM alpine:3.20

RUN adduser -D -u 10001 archiver
COPY --from=build /archive-consumer /usr/local/bin/archive-consumer
USER archiver

CMD ["archive-consumer"]
