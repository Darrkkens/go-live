package server

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func encoded(t *testing.T, format string, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&buf, img)
	case "jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestProcessImage(t *testing.T) {
	got, err := processImage(encoded(t, "png", 5000, 1000))
	if err != nil || got.contentType != "image/png" || got.width != maxAttachmentSide || got.height != 512 {
		t.Fatalf("large png: %+v %v", got.width, err)
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(got.data)); err != nil || cfg.Width != maxAttachmentSide {
		t.Fatalf("scaled output: %v %v", cfg, err)
	}
	got, err = processImage(encoded(t, "jpeg", 300, 900))
	if err != nil || got.contentType != "image/jpeg" || got.ext != ".jpg" || got.width != 300 || got.height != 900 {
		t.Fatalf("jpeg: %+v %v", got.contentType, err)
	}
	original := encoded(t, "gif", 40, 30)
	got, err = processImage(original)
	if err != nil || got.contentType != "image/gif" || !bytes.Equal(got.data, original) {
		t.Fatalf("gif should be kept as sent: %v", err)
	}
	for name, data := range map[string][]byte{"text": []byte("not an image"), "truncated": encoded(t, "png", 50, 50)[:40], "svg": []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)} {
		if _, err := processImage(data); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestProcessDocument(t *testing.T) {
	pdf := []byte("%PDF-1.7\n...")
	if got, err := processDocument("Relatório.PDF", pdf); err != nil || got.contentType != "application/pdf" || got.ext != ".pdf" {
		t.Fatalf("pdf: %+v %v", got.contentType, err)
	}
	if _, err := processDocument("planilha.xlsx", []byte("PK\x03\x04rest")); err != nil {
		t.Fatal(err)
	}
	if _, err := processDocument("notas.txt", []byte("olá\nmundo")); err != nil {
		t.Fatal(err)
	}
	rejected := map[string][]byte{
		"virus.exe":    []byte("MZ\x90\x00"),
		"fake.pdf":     []byte("MZ\x90\x00"),
		"page.html":    []byte("<script>alert(1)</script>"),
		"binary.txt":   []byte("a\x00b"),
		"empty.pdf":    {},
		"no-extension": pdf,
		"image.svg":    []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
	}
	for name, data := range rejected {
		if _, err := processDocument(name, data); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestCleanFileName(t *testing.T) {
	cases := map[string]string{
		"Relatório final.pdf":    "Relatório final.pdf",
		"../../etc/passwd.pdf":   "passwd.pdf",
		`C:\Users\a\doc "x".pdf`: "doc x.pdf",
		"bad\nname\x00.pdf":      "badname.pdf",
		".pdf":                   "arquivo.pdf",
		"":                       "arquivo.pdf",
	}
	for in, want := range cases {
		if got := cleanFileName(in, ".pdf"); got != want {
			t.Errorf("cleanFileName(%q) = %q, want %q", in, got, want)
		}
	}
	long := cleanFileName(strings.Repeat("a", 300)+".pdf", ".pdf")
	if len([]rune(long)) != 120 || !strings.HasSuffix(long, ".pdf") {
		t.Fatalf("long name: %d %q", len([]rune(long)), long[len(long)-8:])
	}
}
