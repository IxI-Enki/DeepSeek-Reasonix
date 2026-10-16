package control

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// CarryDraftAttachments preserves only the draft's stored attachment paths
// when a new conversation starts in a different workspace.
func CarryDraftAttachments(source, destination string, paths []string) error {
	for _, path := range paths {
		if err := carryDraftAttachment(source, destination, path); err != nil {
			return err
		}
	}
	return nil
}

func carryDraftAttachment(source, destination, path string) error {
	rel := filepath.Clean(filepath.FromSlash(path))
	if filepath.IsAbs(path) || filepath.Dir(rel) != filepath.Join(".reasonix", "attachments") {
		return fmt.Errorf("draft attachment must be in the attachment directory")
	}
	sourceRoot, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer sourceRoot.Close()
	f, err := sourceRoot.Open(rel)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	const limit = 25 << 20
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return fmt.Errorf("invalid draft attachment: %s", path)
	}
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return err
	}
	if len(raw) > limit {
		return fmt.Errorf("draft attachment exceeds 25 MB: %s", path)
	}
	destRoot, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer destRoot.Close()
	if err := destRoot.MkdirAll(filepath.Join(".reasonix", "attachments"), 0o700); err != nil {
		return err
	}
	out, err := destRoot.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if os.IsExist(err) {
		existing, openErr := destRoot.Open(rel)
		if openErr == nil {
			defer existing.Close()
			data, readErr := io.ReadAll(io.LimitReader(existing, limit+1))
			if readErr == nil && bytes.Equal(data, raw) {
				return nil
			}
		}
	}
	if err != nil {
		return err
	}
	_, writeErr := out.Write(raw)
	closeErr := out.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}
