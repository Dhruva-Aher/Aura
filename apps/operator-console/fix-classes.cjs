const fs = require('fs');
const path = require('path');

const walkSync = (dir, filelist = []) => {
  fs.readdirSync(dir).forEach(file => {
    const dirFile = path.join(dir, file);
    if (fs.statSync(dirFile).isDirectory()) {
      filelist = walkSync(dirFile, filelist);
    } else {
      if (dirFile.endsWith('.tsx') || dirFile.endsWith('.css')) filelist.push(dirFile);
    }
  });
  return filelist;
};

const files = walkSync('./src');
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/bg-background-main/g, 'bg-main');
  content = content.replace(/bg-background-panel-soft/g, 'bg-panel-soft');
  content = content.replace(/bg-background-panel/g, 'bg-panel');
  content = content.replace(/text-text-primary/g, 'text-primary');
  content = content.replace(/text-text-secondary/g, 'text-secondary');
  content = content.replace(/text-text-muted/g, 'text-muted');
  
  // index.css
  content = content.replace(/theme\('colors\.background\.main'\)/g, "theme('colors.main')");
  content = content.replace(/theme\('colors\.background\.panel'\)/g, "theme('colors.panel')");
  content = content.replace(/theme\('colors\.background\.panel-soft'\)/g, "theme('colors.panel-soft')");
  content = content.replace(/theme\('colors\.text\.primary'\)/g, "theme('colors.primary')");
  content = content.replace(/theme\('colors\.border\.DEFAULT'\)/g, "theme('colors.border')");

  fs.writeFileSync(file, content, 'utf8');
});
console.log('Fixed classes');
