package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/Darrkkens/go-live/internal/accounts"
	"github.com/Darrkkens/go-live/internal/database"
	"golang.org/x/term"
)

func ask(reader *bufio.Reader, label string) string {
	fmt.Print(label)
	value, _ := reader.ReadString('\n')
	return strings.TrimSpace(value)
}

func main() {
	db := database.New()
	defer db.Close()
	store := accounts.Store{DB: db.DB()}
	setupCtx, cancelSetup := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelSetup()
	if err := store.Migrate(setupCtx); err != nil {
		log.Fatal(err)
	}
	exists, err := store.HasMaster(setupCtx)
	if err != nil {
		log.Fatal(err)
	}
	if exists {
		log.Fatal("admin master já existe")
	}
	reader := bufio.NewReader(os.Stdin)
	input := accounts.CreateInput{
		Username: ask(reader, "Nome: "),
		Email:    ask(reader, "E-mail: "),
		UserTag:  ask(reader, "Tag (sem @): "),
	}
	fmt.Print("Senha (mínimo 12 caracteres): ")
	password, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		log.Fatal(err)
	}
	input.Password = string(password)
	createCtx, cancelCreate := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelCreate()
	u, err := store.Create(createCtx, input, "master")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Admin master criado: @%s\n", u.UserTag)
}
