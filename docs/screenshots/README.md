# Screenshots

Drop PNGs in this folder, commit, and push. They are served straight from
GitHub, so each one gets a permanent URL you can use anywhere.

## Using them on the OOTP forums

The forums take an image URL, so link the **raw** file:

```
[IMG]https://raw.githubusercontent.com/lsukev/ootp-front-office/main/docs/screenshots/FILENAME.png[/IMG]
```

Use `raw.githubusercontent.com`, not the `github.com/.../blob/...` address that
appears in your browser bar — the blob URL serves an HTML page, so the forum
will show a broken image.

## Using them in the README

```markdown
![Dashboard](docs/screenshots/dashboard.png)
```

## Notes

- Lowercase, hyphenated filenames keep the URLs clean: `pitching-staff.png`.
- Forum layouts are roughly 900px wide, so anything wider gets scaled down.
  Capturing around 1400px looks sharp on high-DPI screens without being huge.
- Check the shot before committing — anything showing the Settings page will
  include your local file paths, and this repository is public.
