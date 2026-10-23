// Command osrs-dps-calc is a portable launcher for the DPS calculator.
//
// It embeds the static Next.js export, serves it on a fixed localhost port and
// opens it in the default browser. The port is fixed so the browser origin
// stays the same between runs, which keeps saved loadouts (localStorage).
package main

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strings"
)

// basePath must match NEXT_PUBLIC_BASE_PATH used when building the site.
const basePath = "/osrs-dps"

const addr = "127.0.0.1:47812"

var version = "dev"

// The all: prefix is required, otherwise Go skips the _next directory.
//
//go:embed all:site
var embedded embed.FS

func main() {
	site, err := fs.Sub(embedded, "site")
	if err != nil {
		fail(err)
	}
	if _, err := fs.Stat(site, "index.html"); err != nil {
		fail(errors.New("site was not embedded; copy the Next.js out/ directory to desktop/site before building"))
	}

	// Windows sometimes maps .js to text/plain in the registry, which breaks
	// module scripts and workers, so pin the types we serve.
	for ext, typ := range map[string]string{
		".html":  "text/html; charset=utf-8",
		".js":    "text/javascript; charset=utf-8",
		".css":   "text/css; charset=utf-8",
		".json":  "application/json",
		".txt":   "text/plain; charset=utf-8",
		".svg":   "image/svg+xml",
		".png":   "image/png",
		".ico":   "image/x-icon",
		".woff":  "font/woff",
		".woff2": "font/woff2",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}

	url := "http://" + addr + basePath + "/"

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Most likely another copy is already running, so just open it.
		fmt.Printf("Port %s is in use, assuming the calculator is already running.\n", addr)
		openBrowser(url)
		return
	}

	fmt.Printf("OSRS DPS Calculator %s\n", version)
	fmt.Printf("Running at %s\n", url)
	fmt.Println("Keep this window open while using the calculator. Close it to quit.")
	openBrowser(url)

	if err := http.Serve(ln, handler(site)); err != nil {
		fail(err)
	}
}

func handler(site fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == basePath {
			http.Redirect(w, r, basePath+"/", http.StatusFound)
			return
		}
		if !strings.HasPrefix(r.URL.Path, basePath+"/") {
			http.NotFound(w, r)
			return
		}

		name := strings.TrimPrefix(path.Clean(strings.TrimPrefix(r.URL.Path, basePath)), "/")
		if name == "" {
			name = "index.html"
		}
		// Next exports routes as foo.html, but links point at /foo.
		if info, err := fs.Stat(site, name); err != nil || info.IsDir() {
			if _, err := fs.Stat(site, name+".html"); err == nil {
				name += ".html"
			} else {
				serve404(w, site)
				return
			}
		}

		if strings.HasPrefix(name, "_next/static/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFileFS(w, r, site, name)
	})
}

func serve404(w http.ResponseWriter, site fs.FS) {
	page, err := fs.ReadFile(site, "404.html")
	if err != nil {
		http.Error(w, "404 page not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(page)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("Could not open a browser automatically, open %s yourself.\n", url)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	if runtime.GOOS == "windows" {
		// Keep the console open so the message can be read.
		fmt.Println("Press Enter to exit.")
		_, _ = fmt.Scanln()
	}
	os.Exit(1)
}
