package server

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed admin/*
var adminAssets embed.FS

func adminUIHandler() http.Handler {
	files, err := fs.Sub(adminAssets, "admin")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(files))
}
