package server

import (
	"bytes"
	"database/sql"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Darrkkens/go-live/internal/messages"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const maxImageBytes = 10 << 20
const maxFileBytes = 25 << 20
const maxAttachmentPixels = 40_000_000
const maxAttachmentSide = 2560

var errBadImage = errors.New("invalid image")
var errBadFile = errors.New("file type not allowed")

var (
	zipMagic = []byte("PK\x03\x04")
	oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}
)

func hasPrefix(prefix []byte) func([]byte) bool {
	return func(data []byte) bool { return bytes.HasPrefix(data, prefix) }
}

func isText(data []byte) bool {
	return utf8.Valid(data) && !bytes.ContainsRune(data, 0)
}

type fileType struct {
	contentType string
	matches     func([]byte) bool
}

// documentTypes is the allowlist for non-image files. The extension picks the
// type and the content must match it, so renamed executables are rejected.
var documentTypes = map[string]fileType{
	".pdf":  {"application/pdf", hasPrefix([]byte("%PDF-"))},
	".doc":  {"application/msword", hasPrefix(oleMagic)},
	".xls":  {"application/vnd.ms-excel", hasPrefix(oleMagic)},
	".ppt":  {"application/vnd.ms-powerpoint", hasPrefix(oleMagic)},
	".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", hasPrefix(zipMagic)},
	".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", hasPrefix(zipMagic)},
	".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation", hasPrefix(zipMagic)},
	".odt":  {"application/vnd.oasis.opendocument.text", hasPrefix(zipMagic)},
	".ods":  {"application/vnd.oasis.opendocument.spreadsheet", hasPrefix(zipMagic)},
	".odp":  {"application/vnd.oasis.opendocument.presentation", hasPrefix(zipMagic)},
	".zip":  {"application/zip", hasPrefix(zipMagic)},
	".rar":  {"application/vnd.rar", hasPrefix([]byte("Rar!\x1a\x07"))},
	".7z":   {"application/x-7z-compressed", hasPrefix([]byte{'7', 'z', 0xBC, 0xAF, 0x27, 0x1C})},
	".txt":  {"text/plain; charset=utf-8", isText},
	".csv":  {"text/csv; charset=utf-8", isText},
	".md":   {"text/markdown; charset=utf-8", isText},
}

// cleanFileName keeps a safe display name for downloads.
func cleanFileName(name, ext string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '"' || r == '/' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:120-len([]rune(ext))]) + ext
	}
	if name == "" || name == "." || strings.TrimSuffix(name, ext) == "" {
		name = "arquivo" + ext
	}
	return name
}

// processDocument validates a non-image upload against the allowlist.
func processDocument(name string, data []byte) (processedUpload, error) {
	ext := strings.ToLower(filepath.Ext(name))
	kind, ok := documentTypes[ext]
	if !ok || len(data) == 0 || !kind.matches(data) {
		return processedUpload{}, errBadFile
	}
	return processedUpload{data: data, ext: ext, contentType: kind.contentType}, nil
}

func attachmentDir() string {
	if dir := os.Getenv("ATTACHMENT_DIR"); dir != "" {
		return dir
	}
	return filepath.Join("data", "attachments")
}

type processedUpload struct {
	data        []byte
	ext         string
	contentType string
	width       int
	height      int
}

// processImage validates an upload. Still images are re-encoded, which strips
// metadata such as GPS location, and scaled down to maxAttachmentSide. GIFs
// are kept as sent so animations survive.
func processImage(data []byte) (processedUpload, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 12000 || cfg.Height > 12000 || cfg.Width*cfg.Height > maxAttachmentPixels {
		return processedUpload{}, errBadImage
	}
	switch format {
	case "gif":
		if _, err := gif.Decode(bytes.NewReader(data)); err != nil {
			return processedUpload{}, errBadImage
		}
		return processedUpload{data: data, ext: ".gif", contentType: "image/gif", width: cfg.Width, height: cfg.Height}, nil
	case "jpeg", "png", "webp":
	default:
		return processedUpload{}, errBadImage
	}
	img, decoded, err := image.Decode(bytes.NewReader(data))
	if err != nil || decoded != format {
		return processedUpload{}, errBadImage
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w > maxAttachmentSide || h > maxAttachmentSide {
		if w >= h {
			w, h = maxAttachmentSide, max(1, h*maxAttachmentSide/bounds.Dx())
		} else {
			w, h = max(1, w*maxAttachmentSide/bounds.Dy()), maxAttachmentSide
		}
		scaled := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, bounds, draw.Over, nil)
		img = scaled
	}
	var out bytes.Buffer
	if format == "jpeg" {
		err = jpeg.Encode(&out, img, &jpeg.Options{Quality: 85})
		return processedUpload{data: out.Bytes(), ext: ".jpg", contentType: "image/jpeg", width: w, height: h}, err
	}
	err = png.Encode(&out, img)
	return processedUpload{data: out.Bytes(), ext: ".png", contentType: "image/png", width: w, height: h}, err
}

func (s *Server) sendAttachment(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	contactID, ok := validContactID(c)
	if !ok {
		return
	}
	// Large photos on slow connections need more than the server's default read timeout.
	_ = http.NewResponseController(c.Writer).SetReadDeadline(time.Now().Add(2 * time.Minute))
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxFileBytes+(1<<20))
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Selecione um arquivo de até 25 MB."})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil || header.Size > maxFileBytes || len(data) > maxFileBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "O arquivo deve ter até 25 MB."})
		return
	}
	caption := c.PostForm("caption")
	if utf8.RuneCountInString(caption) > messages.MaxBodyRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A legenda pode ter até 4000 caracteres."})
		return
	}
	var img processedUpload
	if _, format, cfgErr := image.DecodeConfig(bytes.NewReader(data)); cfgErr == nil && format != "" {
		if len(data) > maxImageBytes {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "A imagem deve ter até 10 MB."})
			return
		}
		if img, err = processImage(data); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Envie uma imagem PNG, JPEG, WebP ou GIF válida de até 40 megapixels."})
			return
		}
	} else if img, err = processDocument(header.Filename, data); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Tipo de arquivo não permitido. Envie imagens, PDF, documentos do Office/LibreOffice, TXT, CSV, MD, ZIP, RAR ou 7z."})
		return
	}
	displayName := cleanFileName(header.Filename, img.ext)
	if img.width > 0 && !strings.EqualFold(filepath.Ext(displayName), img.ext) {
		displayName = strings.TrimSuffix(displayName, filepath.Ext(displayName)) + img.ext
	}
	dir := attachmentDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar o arquivo."})
		return
	}
	name := uuid.NewString() + img.ext
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, img.data, 0600); err != nil {
		_ = os.Remove(path)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar o arquivo."})
		return
	}
	m, err := s.messages.SendWithAttachment(c.Request.Context(), u.ID, contactID, caption, &messages.Attachment{FileName: name, ContentType: img.contentType, Name: displayName, Size: int64(len(img.data)), Width: img.width, Height: img.height})
	if err != nil {
		_ = os.Remove(path)
		switch {
		case errors.Is(err, messages.ErrRecipient):
			c.JSON(http.StatusNotFound, gin.H{"error": "Contato não encontrado."})
		case errors.Is(err, messages.ErrInvalid):
			c.JSON(http.StatusBadRequest, gin.H{"error": "A legenda pode ter até 4000 caracteres."})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível enviar o arquivo."})
		}
		return
	}
	s.hub.emit(messageEvent{Type: "message", Message: m}, m.SenderID, m.RecipientID)
	c.JSON(http.StatusCreated, m)
}

func (s *Server) getAttachment(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(http.StatusNotFound)
		return
	}
	a, err := s.messages.Attachment(c.Request.Context(), u.ID, id)
	if errors.Is(err, sql.ErrNoRows) {
		c.Status(http.StatusNotFound)
		return
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, max-age=86400, immutable")
	// <img> loads and CORS fetches of the same URL must not share a cache entry.
	c.Header("Vary", "Origin")
	// Images and PDFs may open in the browser; everything else is always a download.
	disposition := "attachment"
	if c.Query("download") != "1" && (a.Kind == "image" || a.ContentType == "application/pdf") {
		disposition = "inline"
	}
	if a.ContentType != "application/pdf" {
		// Chrome's PDF viewer does not load under a sandbox policy.
		c.Header("Content-Security-Policy", "default-src 'none'; sandbox")
	}
	c.Header("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": a.Name}))
	c.Header("Content-Type", a.ContentType)
	c.File(filepath.Join(attachmentDir(), filepath.Base(a.FileName)))
}
