# Accessibility fixture

This page exists only for the accessibility test. It uses every kind of element a published guide can contain, so one scan covers them all.

## Table of contents

- [Text](#text)
- [Lists](#lists)
- [Code](#code)
- [Tables](#tables)
- [Screenshots](#screenshots)

## Text

A paragraph with **strong text**, *emphasis*, `inline code`, an [internal link](/docs/faq), an [anchor link](#lists), an [external link](https://example.com/guide), and a note marker ¹ at the end of a sentence.

A paragraph with an exponent like GF(2⁸) that must stay as written, and an inline ~~strike~~ run.

### Third-level heading

#### Fourth-level heading

##### Fifth-level heading

###### Sixth-level heading

> A block quote with **strong text**, `inline code`, and a [the FAQ](/docs/faq).
>
> A second paragraph inside the quote.

---

## Lists

- An unordered item.
- An item with a [the FAQ](/docs/faq) and `code`.
  - A nested item.
    - A deeper nested item.
- A last item.

1. A first step.
2. A second step with a nested list:
   - A nested bullet.
   - Another nested bullet.
3. A final step.

## Code

A single-line command:

```sh
rom-weaver apply --rom game.nes --patch fix.bps
```

A multi-line block:

```sh
rom-weaver apply \
  --rom game.nes \
  --patch fix.bps \
  --output patched.nes
```

A block wide enough to scroll on a phone:

```text
00000000  4e 45 53 1a 02 01 01 00 00 00 00 00 00 00 00 00  |NES.............|
```

## Tables

| Format | Extension | Reversible | Note |
| ------ | --------- | ---------- | ---- |
| BPS    | `.bps`    | Yes        | Checked ¹ |
| IPS    | `.ips`    | No         | No checksums ² |
| xdelta | `.xdelta` | Yes        | Large files |

| Column one | Column two | Column three | Column four | Column five | Column six | Column seven | Column eight |
| ---------- | ---------- | ------------ | ----------- | ----------- | ---------- | ------------ | ------------ |
| A long cell of text that forces the table past its column | Another long cell of text that forces the table wider | More text | More text | More text | More text | More text | More text |

## Screenshots

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E" width="4" height="4">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E" alt="A blank light-theme screenshot" width="4" height="4">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E" alt="A blank dark-theme screenshot" width="4" height="4">
  </picture>
  <figcaption>A screenshot with a caption.</figcaption>
</figure>

<figure class="docs-screenshot-pair" aria-label="Two blank screenshots side by side">
  <figure class="docs-screenshot">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E" alt="The first blank screenshot" width="4" height="4">
    <figcaption>Before.</figcaption>
  </figure>
  <figure class="docs-screenshot">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E" alt="The second blank screenshot" width="4" height="4">
    <figcaption>After.</figcaption>
  </figure>
</figure>

<details>
<summary>A collapsed section</summary>

Hidden text that opens on demand, with `code` and a [the FAQ](/docs/faq).

</details>
