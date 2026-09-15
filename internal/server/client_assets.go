package server

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed client/* client/vendor/*
var clientAssets embed.FS

func clientUIHandler() http.Handler {
	files, err := fs.Sub(clientAssets, "client")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(files))
}
