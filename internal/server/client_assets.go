package server

import (
	"embed"
	"io/fs"
	"net/http"
)

// Built by `npm --prefix frontend run build` before Go compilation. Use
// scripts/build.sh for local release builds so the embedded UI is always fresh.
//
//go:embed web
var webAssets embed.FS

func clientUIHandler() http.Handler {
	return embeddedUIHandler("web/client")
}

func embeddedUIHandler(directory string) http.Handler {
	files, err := fs.Sub(webAssets, directory)
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(files))
}
