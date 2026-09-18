# Design Inspiration

A personal library for design inspiration. You drop images in, it files them into real folders on your PC.

## Running it

**Double-click `Start Inspiration.cmd`.** That's it — a black window opens and your
browser follows a second later.

**Keep that black window open while you use the site.** It *is* the site. Close it when
you're finished, and the address stops working until you start it again.

If you'd rather use a terminal: `npm start`, then open **http://localhost:4300**.

## Where your images live

Everything is saved in the `library` folder inside this project:

```
design-inspiration/library/<your folder name>/
```

These are ordinary files. You can open that folder in File Explorer, drag images out of it,
back it up, or sync it to OneDrive — the site just reads whatever is in there.

The site never deletes anything on its own. Deleting an image in the site does delete
the real file, and it asks you first.

## Using it

- **New folder** — the `+` next to FOLDERS in the sidebar.
- **Add images** — three ways, whichever suits you:
  - drag images from File Explorer anywhere onto the page
  - paste with `Ctrl+V` (works with screenshots straight from the clipboard)
  - the **Add images** button
- **View one full size** — click it. `Esc` closes.
- **Delete** — the `×` on hover, or the Delete button in the full-size view.

Accepted formats: PNG, JPG, GIF, WebP, SVG, AVIF, BMP. Max 25 MB per image.

## Backing up to GitHub

This project is connected to <https://github.com/m-bezuidenhout/inspo> and **your images are
tracked in git too** — so they back up to GitHub and follow you onto another machine.

After adding images you want to keep safe:

```bash
git add -A
git commit -m "Add inspiration"
git push
```

To pull your library down on another PC: `git clone`, then `npm install`, then start it.

Two things to know:

- An empty folder won't push. Git only tracks files, so a folder shows up on GitHub
  once it has at least one image in it.
- Deleting an image in the site removes it from your PC, but it stays in the repo's
  history. Git keeps everything you've ever committed.

## Notes

- The site runs entirely on your machine. It talks to nothing on the internet
  except git, and only when you push.
