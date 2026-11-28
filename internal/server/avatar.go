package server

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxAvatarBytes = 4 << 20
const maxAvatarRequestBytes = maxAvatarBytes + (1 << 20)

func avatarDir() string {
	if dir := os.Getenv("AVATAR_DIR"); dir != "" {
		return dir
	}
	return filepath.Join("data", "avatars")
}

func avatarImage(data []byte) (image.Image, string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png") || config.Width < 1 || config.Height < 1 || config.Width > 2048 || config.Height > 2048 {
		return nil, "", errors.New("invalid image")
	}
	img, decodedFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || decodedFormat != format {
		return nil, "", errors.New("invalid image")
	}
	return img, format, nil
}

func (s *Server) uploadAvatar(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	name, ok := saveUploadedImage(c, "avatar")
	if !ok {
		return
	}
	updated, err := s.accounts.SetAvatar(c.Request.Context(), u.ID, "/api/avatars/"+name)
	if err != nil {
		removeStoredImage("/api/avatars/" + name)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível atualizar o perfil."})
		return
	}
	removeStoredImage(u.Avatar)
	c.JSON(http.StatusOK, updated)
}

// saveUploadedImage validates the multipart image in field, re-encodes it
// (dropping metadata) into the avatar directory and returns its file name.
// Avatars and server icons share this storage and the /api/avatars/ route.
func saveUploadedImage(c *gin.Context, field string) (string, bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAvatarRequestBytes)
	file, header, err := c.Request.FormFile(field)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Selecione uma imagem PNG ou JPEG de até 4 MB."})
		return "", false
	}
	defer file.Close()
	if header.Size > maxAvatarBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "A imagem deve ter até 4 MB."})
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil || len(data) > maxAvatarBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "A imagem deve ter até 4 MB."})
		return "", false
	}
	img, format, err := avatarImage(data)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Envie uma imagem PNG ou JPEG válida de até 2048 × 2048 pixels."})
		return "", false
	}
	dir := avatarDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar a imagem."})
		return "", false
	}
	ext := ".jpg"
	if format == "png" {
		ext = ".png"
	}
	name := uuid.NewString() + ext
	path := filepath.Join(dir, name)
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar a imagem."})
		return "", false
	}
	if format == "png" {
		err = png.Encode(out, img)
	} else {
		err = jpeg.Encode(out, img, &jpeg.Options{Quality: 85})
	}
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(path)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar a imagem."})
		return "", false
	}
	return name, true
}

// removeStoredImage deletes a previously uploaded avatar or server icon.
func removeStoredImage(url string) {
	if strings.HasPrefix(url, "/api/avatars/") {
		_ = os.Remove(filepath.Join(avatarDir(), filepath.Base(url)))
	}
}

func (s *Server) getAvatar(c *gin.Context) {
	if _, ok := s.currentUser(c); !ok {
		return
	}
	name := c.Param("name")
	base, err := uuid.Parse(strings.TrimSuffix(strings.TrimSuffix(name, ".png"), ".jpg"))
	if err != nil || (name != base.String()+".png" && name != base.String()+".jpg") {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, max-age=3600")
	c.File(filepath.Join(avatarDir(), name))
}
