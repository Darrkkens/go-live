package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"syscall"
	"time"

	"github.com/Darrkkens/go-live/internal/accounts"
	"github.com/Darrkkens/go-live/internal/database"
	"golang.org/x/term"
)

func main() {
	tag := flag.String("tag", "", "UserTag da conta")
	flag.Parse()
	if *tag == "" {
		log.Fatal("informe -tag")
	}
	fmt.Print("Nova senha (mínimo 12 caracteres): ")
	password, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		log.Fatal(err)
	}
	db := database.New()
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := (accounts.Store{DB: db.DB()}).ResetPassword(ctx, *tag, string(password)); err != nil {
		log.Fatal(err)
	}
	fmt.Println("Senha atualizada; sessões anteriores encerradas.")
}
