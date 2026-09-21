# Design Inspiration

A personal library for design inspiration. You drop images in, it works out what they are
and keeps them as real files on your PC, grouped by tag.

## Running it

**Double-click `Start Inspiration.cmd`.** That's it — a black window opens and your
browser follows a second later.

**Keep that black window open while you use the site.** It *is* the site. Close it when
you're finished, and the address stops working until you start it again.

If you'd rather use a terminal: `npm start`, then open **http://localhost:4300**.

## Where your images live

Everything is saved in one folder inside this project:

```
design-inspiration/library/
```

There are no subfolders — grouping is done with **tags**, not directories, so an image can
belong to several groups at once instead of having to pick one.

These are ordinary files. You can open that folder in File Explorer, drag images out of it,
back it up, or sync it to OneDrive — the site just reads whatever is in there.

The site never deletes anything on its own. Deleting an image in the site does delete
the real file, and it asks you first.

## Using it

- **Add images** — three ways, whichever suits you:
  - drag images from File Explorer anywhere onto the page
  - paste with `Ctrl+V` (works with screenshots straight from the clipboard)
  - the **Add images** button

  Drop or paste **with tags selected** and they go straight in, carrying those tags — so
  filtering to `mobile inspo` and dropping adds more images to that group in one gesture.
  With no tags selected, or via the **Add images** button, a dialog opens instead: it shows
  the **type it has worked out for each image** already filled in, and lets you tag the
  whole batch at once.

  The type on that dialog is only a suggestion — the `?` beside it says so. Leave it and
  each image keeps whatever was detected for it; pick one from the list and they all get
  that instead. When a batch is a mix, the dialog says so and keeps each image's own.
- **View one full size** — click it. `Esc` closes.
- **Delete** — the `×` on hover, or the Delete button in the full-size view.
- **Getting around** — the sidebar is the **type** list: click Mobile, UI Component and
  so on to see just those, or All images for everything. **Tags** are the chips under the
  heading, and the two combine: UI Component in the sidebar plus a `client work` tag gets
  you that client's components.

Accepted formats: PNG, JPG, GIF, WebP, SVG, AVIF, BMP. Max 25 MB per image.

## Types and tags

### The type is worked out for you

Every image gets a **type** the moment it goes in — Mobile, Desktop / Web, Dashboard,
UI Component, Brand & Social, Print, Illustration or Other — and wears it as a coloured
badge and an icon in the sidebar. Nothing is sent anywhere to do this; it happens on your PC, from two things the
image already tells us:

- **Its shape.** A 1179×2556 screenshot is a phone. A 1080×1080 is a social post. An
  A4 page is 1:√2. These are reliable, so a screenshot straight off your phone lands in
  the right place with a name like `Screenshot 2026-09-18 141530.png`.
- **Its filename.** If the name says `sales-dashboard` or `poster`, that wins — you knew
  better than the shape did.

**Where it guesses, it says so.** A badge with a dashed outline means the detector
wasn't confident. Hover it to see why it chose what it chose.

One honest limit: **a dashboard is the same shape as any other desktop screen.** Nothing
measurable separates them, so a dashboard is only spotted when the filename says so —
otherwise it arrives as Desktop / Web and you change it in one click. The same goes for
UI Component and Illustration: they are about what is *in* the picture.

So a file called `add-source-modal.png` or `pricing cards.png` lands as UI Component,
while an unnamed crop of the same thing arrives as Desktop / Web or Other with a dashed
badge, waiting for you. Words that trigger it include *component, modal, dialog, dropdown,
menu, navbar, sidebar, form, input, table, card, button, tabs, toggle, slider, tooltip,
empty state, ui kit* and *design system*.

Some deliberate tie-breaks worth knowing:

- `business card` stays **Print** — Print is checked before UI Component.
- **Brand & Social is one type.** A colour palette and the Instagram grid built from it
  belong on the same shelf, so `logo`, `identity`, `instagram` and `carousel` all land
  there — as do square and 4:5 images, by shape alone.
- `brand poster` goes to **Brand & Social**, but a plain `poster` stays **Print**: brand
  words are checked first, so they win when both appear.
- `menu` now means a dropdown, not a restaurant menu, so it lands as **UI Component**.
- `app ui` and `mobile ui` stay **Mobile**: there is no bare "ui" keyword, or every
  screenshot would become a component.

### Fixing a type, and adding tags

Click any image. In the panel underneath:

- **Type** — a dropdown. Change it and it stays changed; the detector never overrules you.
- **Tags** — type one and press `Enter`. Anything you like: `dark mode`, `pricing`,
  `client work`, `colour I want to steal`. The `×` on a tag removes it, and `Backspace`
  in an empty box takes the last one off. Previously used tags autocomplete.

### Filtering

The sidebar picks one **type**. The chips under the heading are your **tags**, and every
count is live: pick UI Component and the tag chips immediately show how many components
carry each tag.

- Clicking **tags** narrows: two tags shows only images carrying both.
- The search box matches filenames and tags.
- `Esc` clears the filters, then the type, as does **Clear filters**.

### Where this is stored

In one plain file, `library/tags.json`, next to your images. It is readable, editable by
hand, and backs up to GitHub with everything else, so your tags follow you between
machines. Your images stay ordinary files with nothing written into them.

If that file is ever lost, nothing breaks — every type is simply worked out again the
next time the library loads. Tags you typed yourself would be gone, though, which is the
one reason to let it get committed.

## Publishing it

The library runs in one of two modes, decided entirely by whether `.env` has
Supabase credentials in it.

| | **Local** (default) | **Hosted** |
|---|---|---|
| Images | a folder on your PC | Supabase Storage |
| Tags and types | `library/tags.json` | a Postgres table |
| Accounts | none | sign in by emailed link |
| Who sees it | you | everyone you invite, sharing **one** library |
| Internet | never | always |

**Nothing changes for local use.** With no `.env`, the app behaves exactly as it
always has. Publishing is additive, not a migration — you can keep using the local
copy afterwards.

### Setting it up

**1. Create the database.** In the Supabase dashboard open **SQL Editor -> New query**,
paste all of [`supabase/schema.sql`](supabase/schema.sql), and run it. That makes the
tables, the private `inspiration` bucket, and the row-level security policies. It is
safe to run twice.

Everyone invited shares **one** library: the same images, the same tags, and anyone can
add to them. Access is decided by membership, so the policies all reduce to "is this
person in this library?" — checked on both the database rows and the stored files.

**2. Fill in `.env`.** Copy `.env.example` to `.env` and paste your keys from
**Project Settings -> API**:

```bash
cp .env.example .env
```

The **anon key** is safe to publish — the security policies are what protect your data.
The **service role key** is not: it bypasses those policies completely, so it stays on
the server and never goes near a browser or a commit. `.env` is git-ignored.

**3. Invite people.** Two steps, because they are two different things:

- **Authentication -> Users -> Invite** gives them an *account*.
- The **People** button in the app's sidebar lets them into *your library*.

The first person to sign in creates the library and becomes its owner. Everyone after
that needs an invite, so **turn off public sign-ups** under **Authentication ->
Providers** — otherwise a stranger could create an account (they would see nothing, but
there is no reason to allow it).

**4. Deploy.** There is a `Dockerfile` and a `fly.toml`:

```bash
fly launch --no-deploy
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy
```

Railway and Render work the same way: point them at the repo, set those three variables
in their dashboard. Secrets go in the platform's own secret store, never in a file.

### Things worth knowing before you rely on it

- **Everyone in the library is equal**, apart from inviting. Any member can retag or
  delete any image, including ones someone else added. That suits a small trusted team
  and would not suit a large one.
- **There is no "who added this".** The database records it, but nothing shows it.
- **Thumbnails are not built.** The grid loads full-size images. Fine at dozens,
  slow at hundreds. Supabase can transform images on the fly when you need it.
- **Signed image links last an hour.** Leave a tab open overnight and the pictures stop
  loading until you reload. The bucket is private, which is the trade for that.

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

- `library/tags.json` is what remembers your tags and types, so commit it along with the
  images or the grouping won't follow you to another machine.
- Deleting an image in the site removes it from your PC, but it stays in the repo's
  history. Git keeps everything you've ever committed.

## Notes

- The site runs entirely on your machine. It talks to nothing on the internet
  except git, and only when you push.
