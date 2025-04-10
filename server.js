const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const app = express();
const port = 3000;

// Enable CORS for all routes
app.use(cors());

// Serve static files from the current directory
app.use(express.static('./'));

// API endpoint to fetch webpage content
app.get('/api/fetch-page', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    // Check if the content is an XML sitemap
    const contentType = response.headers['content-type'] || '';
    const isXml = contentType.includes('xml') || 
                 (response.data && typeof response.data === 'string' && 
                  (response.data.trim().startsWith('<?xml') || 
                   response.data.trim().startsWith('<urlset') || 
                   response.data.trim().startsWith('<sitemapindex')));
    
    if (isXml) {
      try {
        // Parse XML data
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        
        res.json({ 
          success: true, 
          content: response.data,
          isXml: true,
          parsedXml: result
        });
      } catch (xmlError) {
        console.error('Error parsing XML:', xmlError);
        res.json({
          success: true,
          content: response.data,
          isXml: true,
          xmlParseError: xmlError.message
        });
      }
    } else {
      // Regular HTML content
      res.json({ 
        success: true, 
        content: response.data,
        isXml: false
      });
    }
  } catch (error) {
    console.error('Error fetching page:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch the page', 
      message: error.message 
    });
  }
});

// API endpoint to fetch a sitemap index and all its child sitemaps
app.get('/api/process-sitemap-index', async (req, res) => {
  const indexUrl = req.query.url;
  
  if (!indexUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    // Fetch the sitemap index
    const indexResponse = await axios.get(indexUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Check if it's actually XML
    if (!indexResponse.data || typeof indexResponse.data !== 'string' || 
        !(indexResponse.data.includes('<sitemapindex') || indexResponse.data.includes('<urlset'))) {
      return res.status(400).json({ error: 'The provided URL does not appear to be a valid sitemap' });
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
      
      sitemapUrls = sitemaps.map(item => {
        return {
          loc: item.loc || '',
          lastmod: item.lastmod || ''
        };
      });
    }
    
    // Return basic info about the sitemap index
    res.json({
      success: true,
      isSitemapIndex: isSitemapIndex,
      sitemapUrls: sitemapUrls,
      originalData: indexData
    });
    
  } catch (error) {
    console.error('Error processing sitemap index:', error.message);
    res.status(500).json({ 
      error: 'Failed to process the sitemap index', 
      message: error.message 
    });
  }
});

// API endpoint to fetch a single page and check for # links
app.get('/api/check-page-for-hash', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 15000 // 15 seconds timeout for potentially larger pages
    });
    
    // Only proceed if this is HTML content
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return res.json({
        success: false,
        url: url,
        error: 'Not an HTML page',
        hasHashLinks: false,
        hashLinks: [],
        headerHashLinks: [],
        footerHashLinks: []
      });
    }
    
    // Extract links with href="#" or href="/#"
    const htmlContent = response.data;
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;
    
    // Identify header elements to check separately
    const headerElements = [
      ...document.getElementsByTagName('header'),
      ...document.querySelectorAll('nav'),
      ...document.querySelectorAll('.header'),
      ...document.querySelectorAll('#header'),
      ...document.querySelectorAll('.navigation'),
      ...document.querySelectorAll('#navigation'),
      ...document.querySelectorAll('.main-nav'),
      ...document.querySelectorAll('#main-nav'),
      ...document.querySelectorAll('.navbar'),
      ...document.querySelectorAll('#navbar')
    ];
    
    // Identify footer elements to check separately
    const footerElements = [
      ...document.getElementsByTagName('footer'),
      ...document.querySelectorAll('.footer'),
      ...document.querySelectorAll('#footer'),
      ...document.querySelectorAll('.site-footer'),
      ...document.querySelectorAll('#site-footer'),
      ...document.querySelectorAll('.bottom-footer'),
      ...document.querySelectorAll('.page-footer'),
      ...document.querySelectorAll('.copyright-footer'),
      ...document.querySelectorAll('[role="contentinfo"]')
    ];
    
    const headerHashLinks = [];
    const footerHashLinks = [];
    const hashLinks = [];
    
    // Function to check if an element is inside a header
    const isInsideHeader = (element) => {
      let current = element;
      while (current) {
        if (headerElements.includes(current)) {
          return true;
        }
        current = current.parentNode;
      }
      return false;
    };
    
    // Function to check if an element is inside a footer
    const isInsideFooter = (element) => {
      let current = element;
      while (current) {
        if (footerElements.includes(current)) {
          return true;
        }
        current = current.parentNode;
      }
      return false;
    };
    
    // Extract context from a link
    const extractContext = (link) => {
      let context = '';
      
      // Try to get a parent element with an ID or class for context
      let contextElement = link.parentNode;
      let depth = 0;
      const maxDepth = 3; // Don't go too far up the tree
      
      while (contextElement && depth < maxDepth) {
        if (contextElement.id || 
            (contextElement.className && contextElement.className.trim())) {
          context = contextElement.id 
            ? `Inside element with id="${contextElement.id}"` 
            : `Inside element with class="${contextElement.className.trim()}"`;
          break;
        }
        contextElement = contextElement.parentNode;
        depth++;
      }
      
      if (!context) {
        // If no good parent context found, get surrounding text
        const parentText = link.parentNode?.textContent?.trim();
        if (parentText && parentText.length > link.textContent.trim().length) {
          const maxLength = 100;
          context = `Near text: "${parentText.substring(0, maxLength)}${parentText.length > maxLength ? '...' : ''}"`;
        }
      }
      
      return context || 'No context available';
    };
    
    // Function to format link text to handle multiple HTML tags
    function formatLinkText(link) {
      // If there are no children elements, just return the text
      if (link.children.length === 0) {
        return link.textContent.trim() || '[No text]';
      }
      
      // Link has child elements - need to process them
      const parts = [];
      
      // Get the text directly in the link (not in child elements)
      const directText = Array.from(link.childNodes)
        .filter(node => node.nodeType === 3) // Text nodes only
        .map(node => node.textContent.trim())
        .filter(text => text.length > 0)
        .join(' ');
      
      if (directText) {
        parts.push(directText);
      }
      
      // Get text from each child element
      Array.from(link.children).forEach(child => {
        const childText = child.textContent.trim();
        if (childText) {
          parts.push(childText);
        }
      });
      
      // Join with pipe symbols
      return parts.join(' | ') || link.textContent.trim() || '[No text]';
    }
    
    // First, check all links in header elements
    headerElements.forEach(headerElement => {
      const links = headerElement.getElementsByTagName('a');
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const href = link.getAttribute('href');
        
        if (href === '#' || href === '/#') {
          const context = extractContext(link);
          
          headerHashLinks.push({
            text: formatLinkText(link),
            href: href,
            context: context,
            headerType: headerElement.tagName.toLowerCase() + 
                       (headerElement.id ? ` (id=${headerElement.id})` : '') + 
                       (headerElement.className ? ` (class=${headerElement.className})` : '')
          });
        }
      }
    });
    
    // Second, check all links in footer elements
    footerElements.forEach(footerElement => {
      const links = footerElement.getElementsByTagName('a');
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const href = link.getAttribute('href');
        
        if (href === '#' || href === '/#') {
          const context = extractContext(link);
          
          footerHashLinks.push({
            text: formatLinkText(link),
            href: href,
            context: context,
            footerType: footerElement.tagName.toLowerCase() + 
                       (footerElement.id ? ` (id=${footerElement.id})` : '') + 
                       (footerElement.className ? ` (class=${footerElement.className})` : '')
          });
        }
      }
    });
    
    // Then check all other links that are not in headers or footers
    const allLinks = document.getElementsByTagName('a');
    for (let i = 0; i < allLinks.length; i++) {
      const link = allLinks[i];
      const href = link.getAttribute('href');
      
      if ((href === '#' || href === '/#') && !isInsideHeader(link) && !isInsideFooter(link)) {
        const context = extractContext(link);
        
        hashLinks.push({
          text: formatLinkText(link),
          href: href,
          context: context
        });
      }
    }
    
    res.json({
      success: true,
      url: url,
      hasHashLinks: hashLinks.length > 0,
      hashLinks: hashLinks,
      hasHeaderHashLinks: headerHashLinks.length > 0,
      headerHashLinks: headerHashLinks,
      hasFooterHashLinks: footerHashLinks.length > 0,
      footerHashLinks: footerHashLinks
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
      footerHashLinks: []
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}); 