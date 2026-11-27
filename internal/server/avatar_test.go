package server

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestAvatarImage(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	decoded, format, err := avatarImage(data.Bytes())
	if err != nil || format != "png" || decoded.Bounds().Dx() != 2 {
		t.Fatalf("valid PNG rejected: %v", err)
	}
	if _, _, err := avatarImage([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)); err == nil {
		t.Fatal("SVG accepted")
	}
	large := image.NewRGBA(image.Rect(0, 0, 2049, 1))
	data.Reset()
	if err := png.Encode(&data, large); err != nil {
		t.Fatal(err)
	}
	if _, _, err := avatarImage(data.Bytes()); err == nil {
		t.Fatal("oversized image accepted")
	}
}
