use pulldown_cmark::{html, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::ops::Range;

pub fn markdown_options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    options
}

pub fn render_html(markdown: &str) -> String {
    let parser = Parser::new_ext(markdown, markdown_options());
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);
    html_output
}

pub fn render_mapped(markdown: &str) -> String {
    let items: Vec<(Event, Range<usize>)> = Parser::new_ext(markdown, markdown_options())
        .into_offset_iter()
        .collect();

    let n = items.len();
    let mut open_at: Vec<Option<(usize, usize, &'static str, bool)>> = vec![None; n];
    let mut close_at = vec![false; n];
    let mut close_inside = vec![false; n];
    let mut stack: Vec<(usize, bool, &'static str)> = Vec::new();

    for (i, (event, range)) in items.iter().enumerate() {
        match event {
            Event::Start(tag) => {
                if let Some((kind, inside)) = wrap_info(tag) {
                    stack.push((i, inside, kind));
                }
            }
            Event::End(tag_end) => {
                if is_wrap_end(tag_end) {
                    if let Some((start_i, inside, kind)) = stack.pop() {
                        let start = items[start_i].1.start;
                        let end = trim_block_end(markdown, start, range.end.max(items[start_i].1.end));
                        open_at[start_i] = Some((start, end, kind, inside));
                        close_at[i] = true;
                        close_inside[i] = inside;
                    }
                }
            }
            Event::Rule => {
                let start = range.start;
                let end = trim_block_end(markdown, start, range.end);
                open_at[i] = Some((start, end, "hr", false));
                close_at[i] = true;
            }
            _ => {}
        }
    }

    let mut mapped = Vec::with_capacity(items.len() + 16);
    for (i, (event, _)) in items.into_iter().enumerate() {
        if let Some((start, end, kind, inside)) = open_at[i] {
            let open = Event::Html(wrap_open(start, end, kind));
            if inside {
                mapped.push(event);
                mapped.push(open);
            } else {
                mapped.push(open);
                mapped.push(event);
            }
            if close_at[i] {
                mapped.push(Event::Html(CowStr::from("</div>")));
            }
            continue;
        }

        if close_at[i] {
            if close_inside[i] {
                mapped.push(Event::Html(CowStr::from("</div>")));
                mapped.push(event);
            } else {
                mapped.push(event);
                mapped.push(Event::Html(CowStr::from("</div>")));
            }
            continue;
        }

        mapped.push(event);
    }

    let mut html_output = String::new();
    html::push_html(&mut html_output, mapped.into_iter());
    html_output
}

fn wrap_open(start: usize, end: usize, kind: &str) -> CowStr<'static> {
    CowStr::from(format!(
        "<div class=\"md-block\" data-start=\"{start}\" data-end=\"{end}\" data-kind=\"{kind}\">"
    ))
}

fn wrap_info(tag: &Tag<'_>) -> Option<(&'static str, bool)> {
    match tag {
        Tag::Paragraph => Some(("p", false)),
        Tag::Heading { level, .. } => Some((heading_kind(*level), false)),
        Tag::BlockQuote(_) => Some(("quote", false)),
        Tag::CodeBlock(_) => Some(("code", false)),
        Tag::HtmlBlock => Some(("html", false)),
        Tag::Item => Some(("li", true)),
        Tag::Table(_) => Some(("table", false)),
        Tag::FootnoteDefinition(_) => Some(("fn", false)),
        Tag::DefinitionListTitle => Some(("dt", true)),
        Tag::DefinitionListDefinition => Some(("dd", true)),
        _ => None,
    }
}

fn is_wrap_end(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
    )
}

fn heading_kind(level: HeadingLevel) -> &'static str {
    match level {
        HeadingLevel::H1 => "h1",
        HeadingLevel::H2 => "h2",
        HeadingLevel::H3 => "h3",
        HeadingLevel::H4 => "h4",
        HeadingLevel::H5 => "h5",
        HeadingLevel::H6 => "h6",
    }
}

fn trim_block_end(src: &str, start: usize, mut end: usize) -> usize {
    let bytes = src.as_bytes();
    end = end.min(src.len());
    let start = start.min(end);
    while end > start && (bytes[end - 1] == b'\n' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    while end > start && !src.is_char_boundary(end) {
        end -= 1;
    }
    end
}
