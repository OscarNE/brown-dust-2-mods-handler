// src-tauri/src/crawler.rs

use crate::db;
use crate::types::{CrawledCharacter, CrawledCostume, CrawlerReport, SourceCfg};
use deunicode::deunicode;
use headless_chrome::{Browser, LaunchOptions};
use reqwest::Client;
use scraper::{Html, Selector};
use std::time::Duration;

type SResult<T> = Result<T, String>;

#[derive(Debug, Clone)]
pub struct HtmlSelectors {
    pub char_selector: &'static str,
    pub char_name_selector: &'static str,
    pub costume_selector: &'static str,
    pub costume_name_selector: &'static str,
}

// Primary guess (what we wired earlier):
pub const SEL_PRIMARY: HtmlSelectors = HtmlSelectors {
    char_selector: "div.col-mobile-6",
    char_name_selector: "h4 > a",
    costume_selector: "ul.list-group > li",
    costume_name_selector: "a",
};

// Fallback candidates you can try in order.
// Tweak or add more as you inspect the live DOM.
pub const SEL_FALLBACKS: &[HtmlSelectors] = &[
    // Variant with media-body cards
    HtmlSelectors {
        char_selector: ".media-body",
        char_name_selector: "h5.mb-1 > a, h4 > a, .name a",
        costume_selector: ".list-group .list-group-item",
        costume_name_selector: "a, .cname, span",
    },
    // Generic card columns
    HtmlSelectors {
        char_selector: "[class*='col-']",
        char_name_selector: "h4 a, h5 a, .name a",
        costume_selector: "ul.list-group li, .costume, .costumes li",
        costume_name_selector: "a, .cname, span",
    },
];

#[derive(Debug, Clone)]
pub struct HardHtmlSource {
    pub url: &'static str,
    pub sel: HtmlSelectors,
}

pub const HARDCODED_SOURCES: &[HardHtmlSource] = &[HardHtmlSource {
    url: "https://browndust2-wiki.souseha.com/en/costumes",
    sel: HtmlSelectors {
        char_selector: "div.col-mobile-6",
        char_name_selector: "h4 > a",
        costume_selector: "ul.list-group > li",
        costume_name_selector: "a",
    },
}];

fn slugify(s: &str) -> String {
    let lower = deunicode(&s.to_lowercase());
    lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn parse_with_selectors(html: &str, s: &HtmlSelectors) -> (Vec<CrawledCharacter>, usize, usize) {
    let doc = Html::parse_document(html);

    let sel_char = match Selector::parse(s.char_selector) {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "[crawler] selector error char_selector='{}': {}",
                s.char_selector, e
            );
            return (vec![], 0, 0);
        }
    };
    let sel_char_name = match Selector::parse(s.char_name_selector) {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "[crawler] selector error char_name_selector='{}': {}",
                s.char_name_selector, e
            );
            return (vec![], 0, 0);
        }
    };
    let sel_costume = match Selector::parse(s.costume_selector) {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "[crawler] selector error costume_selector='{}': {}",
                s.costume_selector, e
            );
            return (vec![], 0, 0);
        }
    };
    let sel_costume_name = match Selector::parse(s.costume_name_selector) {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "[crawler] selector error costume_name_selector='{}': {}",
                s.costume_name_selector, e
            );
            return (vec![], 0, 0);
        }
    };

    let mut out = Vec::new();
    let mut char_count = 0usize;
    let mut costume_count = 0usize;

    for c in doc.select(&sel_char) {
        let name = c
            .select(&sel_char_name)
            .next()
            .map(|n| n.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        char_count += 1;

        let mut costumes = Vec::new();
        let mut local_costumes = 0usize;
        for cc in c.select(&sel_costume) {
            let cname = cc
                .select(&sel_costume_name)
                .next()
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();
            if cname.is_empty() {
                continue;
            }
            local_costumes += 1;
            costumes.push(CrawledCostume {
                slug: slugify(&cname),
                display_name: cname,
                aliases: vec![],
            });
        }
        costume_count += local_costumes;

        out.push(CrawledCharacter {
            slug: slugify(&name),
            display_name: name,
            aliases: vec![],
            costumes,
        });
    }

    (out, char_count, costume_count)
}

fn parse_hardcoded_html(html: &str, primary: &HtmlSelectors) -> SResult<Vec<CrawledCharacter>> {
    eprintln!("[crawler] parsing HTML with PRIMARY selectors…");
    let (items, chars, costs) = parse_with_selectors(html, primary);
    eprintln!(
        "[crawler] PRIMARY matched: {} characters, {} costumes",
        chars, costs
    );
    if !items.is_empty() {
        // log first few
        for ch in items.iter().take(3) {
            eprintln!(
                "[crawler] char='{}' costumes={}",
                ch.display_name,
                ch.costumes.len()
            );
        }
        return Ok(items);
    }

    for (i, alt) in SEL_FALLBACKS.iter().enumerate() {
        eprintln!("[crawler] trying FALLBACK #{} …", i + 1);
        let (items, chars, costs) = parse_with_selectors(html, alt);
        eprintln!(
            "[crawler] FALLBACK #{} matched: {} characters, {} costumes",
            i + 1,
            chars,
            costs
        );
        if !items.is_empty() {
            for ch in items.iter().take(3) {
                eprintln!(
                    "[crawler] char='{}' costumes={}",
                    ch.display_name,
                    ch.costumes.len()
                );
            }
            return Ok(items);
        }
    }

    eprintln!("[crawler] No selectors matched any characters. The page may be JS-rendered or structure changed.");
    Err("no matches with available selectors".to_string())
}

async fn fetch_html(client: &Client, url: &str) -> SResult<String> {
    eprintln!("[crawler] GET {}", url);
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    eprintln!("[crawler] status={} bytes={}", status, text.len());
    if !status.is_success() {
        eprintln!(
            "[crawler] non-200 HTML preview:\n{}",
            &text.chars().take(400).collect::<String>()
        );
    } else if text.len() < 5000 {
        // If the page is JS-rendered, static HTML is often tiny.
        eprintln!(
            "[crawler] WARNING: body small ({} bytes) – page may be JS-rendered.",
            text.len()
        );
        eprintln!(
            "[crawler] HTML head preview:\n{}",
            &text.chars().take(400).collect::<String>()
        );
    }
    Ok(text)
}

pub async fn fetch_all_hardcoded() -> SResult<Vec<CrawledCharacter>> {
    // choose a wait selector that exists once content loads
    let wait_sel = Some("div.col-mobile-6, .media-body, ul.list-group");

    let mut all = Vec::new();
    for src in HARDCODED_SOURCES.iter() {
        // Try headless render first
        let html = match fetch_rendered_html(src.url, wait_sel).await {
            Ok(h) => {
                eprintln!("[crawler] headless render succeeded, bytes={}", h.len());
                h
            }
            Err(e) => {
                eprintln!(
                    "[crawler] headless render failed: {} — falling back to simple HTTP",
                    e
                );
                // fallback: simple fetch (likely empty, but good for resilience)
                let client = reqwest::Client::new();
                fetch_html(&client, src.url).await?
            }
        };

        let items = parse_hardcoded_html(&html, &src.sel)?;
        all.extend(items);
    }
    Ok(all)
}

pub fn persist_crawled(items: Vec<CrawledCharacter>) -> SResult<CrawlerReport> {
    let mut conn = db::open_db().map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut chars_count = 0usize;
    let mut costs_count = 0usize;

    for ch in items {
        let ch_id = crate::types::upsert_character(&tx, &ch.slug, &ch.display_name)
            .map_err(|e| e.to_string())?;
        chars_count += 1;
        for a in ch.aliases.iter() {
            crate::types::upsert_alias(&tx, "character", ch_id, a).map_err(|e| e.to_string())?;
        }
        for co in ch.costumes {
            let co_id = crate::types::upsert_costume(&tx, ch_id, &co.slug, &co.display_name)
                .map_err(|e| e.to_string())?;
            costs_count += 1;
            for a in co.aliases.iter() {
                crate::types::upsert_alias(&tx, "costume", co_id, a).map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(CrawlerReport {
        sources: HARDCODED_SOURCES.len(),
        characters: chars_count,
        costumes: costs_count,
    })
}

async fn fetch_rendered_html(url: &str, wait_for_selector: Option<&str>) -> SResult<String> {
    // Launch headless Chrome
    let browser = Browser::new(
        LaunchOptions::default_builder()
            .headless(true)
            .build()
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let tab = browser.new_tab().map_err(|e| e.to_string())?;
    tab.navigate_to(url).map_err(|e| e.to_string())?;

    // Wait for a selector that indicates content has loaded
    // Use the character container or a common piece like ".list-group"
    let sel = wait_for_selector.unwrap_or("ul.list-group");
    tab.wait_for_element(sel).map_err(|e| e.to_string())?;

    // Give the page a bit more time if it lazy-loads (tweak if needed)
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Get the HTML content
    let html = tab.get_content().map_err(|e| e.to_string())?;
    Ok(html)
}
