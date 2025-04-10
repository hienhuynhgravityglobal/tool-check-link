const express = require("express");
const axios = require("axios");
const cors = require("cors");
const xml2js = require("xml2js");
const app = express();
const port = 3000;

// Enable CORS for all routes
app.use(cors());

// Serve static files from the current directory
app.use(express.static("./"));

// Cache to store already processed headers
const processedHeaders = new Map();

// API endpoint to fetch webpage content
app.get("/api/fetch-page", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000, // 10 seconds timeout
    });

    // Check if the content is an XML sitemap
    const contentType = response.headers["content-type"] || "";
    const isXml =
      contentType.includes("xml") ||
      (response.data &&
        typeof response.data === "string" &&
        (response.data.trim().startsWith("<?xml") ||
          response.data.trim().startsWith("<urlset") ||
          response.data.trim().startsWith("<sitemapindex")));

    if (isXml) {
      try {
        // Parse XML data
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);

        res.json({
          success: true,
          content: response.data,
          isXml: true,
          parsedXml: result,
        });
      } catch (xmlError) {
        console.error("Error parsing XML:", xmlError);
        res.json({
          success: true,
          content: response.data,
          isXml: true,
          xmlParseError: xmlError.message,
        });
      }
    } else {
      // Regular HTML content
      res.json({
        success: true,
        content: response.data,
        isXml: false,
      });
    }
  } catch (error) {
    console.error("Error fetching page:", error.message);
    res.status(500).json({
      error: "Failed to fetch the page",
      message: error.message,
    });
  }
});

// API endpoint to fetch a sitemap index and all its child sitemaps
app.get("/api/process-sitemap-index", async (req, res) => {
  const indexUrl = req.query.url;

  if (!indexUrl) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    // Fetch the sitemap index
    const indexResponse = await axios.get(indexUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    // Check if it's actually XML
    if (
      !indexResponse.data ||
      typeof indexResponse.data !== "string" ||
      !(
        indexResponse.data.includes("<sitemapindex") ||
        indexResponse.data.includes("<urlset")
      )
    ) {
      return res
        .status(400)
        .json({
          error: "The provided URL does not appear to be a valid sitemap",
        });
    }

    // Parse the sitemap index
    const parser = new xml2js.Parser({ explicitArray: false });
    const indexData = await parser.parseStringPromise(indexResponse.data);

    // Determine if this is a sitemap index or a regular sitemap
    let sitemapUrls = [];
    let isSitemapIndex = false;

    if (indexData.sitemapindex && indexData.sitemapindex.sitemap) {
      // This is a sitemap index
      isSitemapIndex = true;
      const sitemaps = Array.isArray(indexData.sitemapindex.sitemap)
        ? indexData.sitemapindex.sitemap
        : [indexData.sitemapindex.sitemap];

      sitemapUrls = sitemaps.map((item) => {
        return {
          loc: item.loc || "",
          lastmod: item.lastmod || "",
        };
      });
    }

    // Return basic info about the sitemap index
    res.json({
      success: true,
      isSitemapIndex: isSitemapIndex,
      sitemapUrls: sitemapUrls,
      originalData: indexData,
    });
  } catch (error) {
    console.error("Error processing sitemap index:", error.message);
    res.status(500).json({
      error: "Failed to process the sitemap index",
      message: error.message,
    });
  }
});

// API endpoint to fetch a single page and check for # links
app.get("/api/check-page-for-hash", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL parameter is required" });

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 15000,
    });

    const contentType = response.headers["content-type"] || "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return res.json({
        success: false,
        url: url,
        error: "Not an HTML page",
        hasHashLinks: false,
        hashLinks: [],
        headerHashLinks: [],
      });
    }

    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(response.data);
    const document = dom.window.document;

    const allLinks = document.getElementsByTagName("a");
    const hashLinks = [];
    const headerHashLinks = [];
    const headerElements = extractHeaderElements(document);
    const newHeadersFound = [];
    let skippedHeaders = 0;

    for (let i = 0; i < allLinks.length; i++) {
      const link = allLinks[i];
      const href = link.getAttribute("href");

      // Use the new isHashLink function instead of direct comparison
      if (isHashLink(href)) {
        let context = "";
        const headerInfo = isElementInHeaderOrNav(
          link,
          document,
          headerElements
        );

        if (headerInfo) {
          const { headerElement, selector } = headerInfo;
          const headerFingerprint = createHeaderFingerprint(headerElement);

          // Tạo một khóa duy nhất cho liên kết dựa trên nội dung
          const linkText = getFormattedLinkText(link);
          const linkKey = `${linkText}-${href}-${selector}`;

          // Kiểm tra xem header đã được xử lý chưa
          if (processedHeaders.has(headerFingerprint)) {
            const existingLinks = processedHeaders.get(headerFingerprint);
            if (existingLinks.includes(linkKey)) {
              skippedHeaders++;
              continue; // Bỏ qua nếu liên kết đã được xử lý
            } else {
              existingLinks.push(linkKey);
              processedHeaders.set(headerFingerprint, existingLinks);
            }
          } else {
            processedHeaders.set(headerFingerprint, [linkKey]);
            newHeadersFound.push(headerFingerprint);
          }

          context = `Found in navigation/header element: ${selector}`;
          headerHashLinks.push({
            text: linkText,
            href: href, // Use the actual href value
            context: context,
            headerType: selector,
          });
        } else {
          // Xử lý liên kết thông thường (không trong header)
          let contextElement = link.parentNode;
          let depth = 0;
          const maxDepth = 3;

          while (contextElement && depth < maxDepth) {
            if (
              contextElement.id ||
              (contextElement.className && contextElement.className.trim())
            ) {
              context = contextElement.id
                ? `Inside element with id="${contextElement.id}"`
                : `Inside element with class="${contextElement.className.trim()}"`;
              break;
            }
            contextElement = contextElement.parentNode;
            depth++;
          }

          if (!context) {
            const parentText = link.parentNode?.textContent?.trim();
            if (
              parentText &&
              parentText.length > link.textContent.trim().length
            ) {
              const maxLength = 100;
              context = `Near text: "${parentText.substring(0, maxLength)}${
                parentText.length > maxLength ? "..." : ""
              }"`;
            }
          }

          hashLinks.push({
            text: getFormattedLinkText(link),
            href: href, // Use the actual href value
            context: context || "No context available",
          });
        }
      }
    }

    res.json({
      success: true,
      url: url,
      hasHashLinks: hashLinks.length > 0 || headerHashLinks.length > 0,
      hashLinks: hashLinks,
      headerHashLinks: headerHashLinks,
      headerStats: {
        newHeadersFound: newHeadersFound.length,
        skippedLinks: skippedHeaders,
        totalHeadersProcessed: processedHeaders.size,
      },
    });
  } catch (error) {
    console.error(`Error checking page ${url} for hash links:`, error.message);
    res.json({
      success: false,
      url: url,
      error: error.message,
      hasHashLinks: false,
      hashLinks: [],
      headerHashLinks: [],
    });
  }
});

// Extract header elements from the document
function extractHeaderElements(document) {
  return {
    header: Array.from(document.getElementsByTagName("header")),
    nav: Array.from(document.querySelectorAll("nav")),
    headerClass: Array.from(document.querySelectorAll(".header")),
    headerId: Array.from(document.querySelectorAll("#header")),
    navigationClass: Array.from(document.querySelectorAll(".navigation")),
    navigationId: Array.from(document.querySelectorAll("#navigation")),
    mainNavClass: Array.from(document.querySelectorAll(".main-nav")),
    mainNavId: Array.from(document.querySelectorAll("#main-nav")),
    navbarClass: Array.from(document.querySelectorAll(".navbar")),
    navbarId: Array.from(document.querySelectorAll("#navbar")),
    // Add footer elements for detection
    footer: Array.from(document.getElementsByTagName("footer")),
    footerClass: Array.from(document.querySelectorAll(".footer")),
    footerId: Array.from(document.querySelectorAll("#footer")),
    footerBottom: Array.from(document.querySelectorAll(".footer-bottom")),
    footerMenu: Array.from(document.querySelectorAll(".footer__menu")),
    footerLinks: Array.from(document.querySelectorAll(".footer__links")),
  };
}

// Create a fingerprint for a header element to identify duplicates
function createHeaderFingerprint(element) {
  // Use a combination of tag name, class list, and simplified innerHTML
  const tagName = element.tagName?.toLowerCase() || "";
  const classList = element.classList
    ? Array.from(element.classList).sort().join(" ")
    : "";

  // Get inner HTML, remove whitespace and normalize to create consistent fingerprint
  let innerHtml = element.innerHTML || "";
  innerHtml = innerHtml.replace(/\s+/g, " ").trim().substring(0, 200); // Limit length to keep fingerprint manageable

  // Create a hash of the element structure
  return `${tagName}-${classList}-${createHash(innerHtml)}`;
}

// Simple hash function for strings
function createHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36); // Convert to base 36 for shorter string
}

// Helper function to check if element is in header/nav
function isElementInHeaderOrNav(element, document, headerElements) {
  // Header and navigation related elements
  const headerSelectors = [
    { type: "header", elements: headerElements.header },
    { type: "nav", elements: headerElements.nav },
    { type: ".header", elements: headerElements.headerClass },
    { type: "#header", elements: headerElements.headerId },
    { type: ".navigation", elements: headerElements.navigationClass },
    { type: "#navigation", elements: headerElements.navigationId },
    { type: ".main-nav", elements: headerElements.mainNavClass },
    { type: "#main-nav", elements: headerElements.mainNavId },
    { type: ".navbar", elements: headerElements.navbarClass },
    { type: "#navbar", elements: headerElements.navbarId },
    // Add footer elements to the selectors
    { type: "footer", elements: headerElements.footer },
    { type: ".footer", elements: headerElements.footerClass },
    { type: "#footer", elements: headerElements.footerId },
    { type: ".footer-bottom", elements: headerElements.footerBottom },
    { type: ".footer__menu", elements: headerElements.footerMenu },
    { type: ".footer__links", elements: headerElements.footerLinks },
  ];

  // Check if the element itself or any of its ancestors match the selectors
  let current = element;
  while (current && current !== document.body) {
    for (const { type, elements } of headerSelectors) {
      if (elements.includes(current)) {
        return { headerElement: current, selector: type };
      }
    }
    current = current.parentNode;
  }

  return false;
}

// Add this new function to extract and format text from elements
function getFormattedLinkText(link) {
  // If the link has no children or only text nodes, return its text content
  if (link.children.length === 0) {
    return link.textContent.trim() || "[No text]";
  }

  // Link has child elements - we need to process them
  let formattedText = "";
  const childElements = Array.from(link.querySelectorAll("*"));

  // If there are no nested elements deeper than direct children
  if (childElements.length === 0) {
    return link.textContent.trim() || "[No text]";
  }

  // Extract text from each child element
  const textParts = [];
  let lastElement = null;

  // Add the link's direct text first if any
  const directText = Array.from(link.childNodes)
    .filter((node) => node.nodeType === 3) // Text nodes
    .map((node) => node.textContent.trim())
    .filter((text) => text.length > 0)
    .join(" ");

  if (directText) {
    textParts.push(directText);
  }

  // Process each child element
  childElements.forEach((element) => {
    // Skip empty elements or those with no text
    const elementText = element.textContent.trim();
    if (!elementText) return;

    // Skip if this element contains other elements we'll process separately
    if (element.querySelector("*")) return;

    // If this is a direct child of the link or a leaf node
    if (
      element.parentNode === link ||
      !Array.from(element.childNodes).some((n) => n.nodeType === 1)
    ) {
      if (lastElement !== element.parentNode) {
        textParts.push(elementText);
        lastElement = element;
      }
    }
  });

  // Join with pipe symbols and remove multiple spaces
  formattedText = textParts
    .filter(Boolean)
    .join(" | ")
    .replace(/\s+/g, " ")
    .trim();

  return formattedText || link.textContent.trim() || "[No text]";
}

// Also add a helper function at the end to identify hash-like links more comprehensively:
function isHashLink(href) {
  if (!href) return false;
  
  // Normalize the href by trimming it
  const normalizedHref = href.trim();
  
  // Check for common patterns:
  // - "#" - Simple hash
  // - "/#" - Hash with leading slash
  // - "#/" - Hash with trailing slash
  return (
    normalizedHref === "#" ||
    normalizedHref === "/#" ||
    normalizedHref === "#/"
  );
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
