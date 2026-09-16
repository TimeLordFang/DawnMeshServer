package server

import "net/http"

func adminUIHandler() http.Handler {
	return embeddedUIHandler("web/admin")
}
