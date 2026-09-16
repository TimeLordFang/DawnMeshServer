package server

import (
	"embed"
	"io/fs"
	"net/http"
)

// Built by `npm --prefix frontend run build`. Committed assets also allow a
// plain go build without Node.js on the deployment/build machine.
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
