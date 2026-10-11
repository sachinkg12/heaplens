import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
const config:Config={
  title:'HeapLens',tagline:'From heap snapshot to code investigation',favicon:'img/heaplens.svg',
  future:{v4:true},url:'https://sachinkg12.github.io',baseUrl:'/heaplens/',trailingSlash:true,
  organizationName:'sachinkg12',projectName:'heaplens',onBrokenLinks:'throw',
  markdown:{hooks:{onBrokenMarkdownLinks:'throw'}},
  i18n:{defaultLocale:'en',locales:['en']},
  presets:[['classic',{docs:{sidebarPath:'./sidebars.ts',editUrl:'https://github.com/sachinkg12/heaplens/tree/main/docs-site/'},blog:false,theme:{customCss:'./src/css/custom.css'}} satisfies Preset.Options]],
  plugins:['./plugins/local-search.cjs'],
  themeConfig:{
    image:'img/heaplens-social.png',
    colorMode:{defaultMode:'light',respectPrefersColorScheme:true},
    navbar:{title:'HeapLens',logo:{alt:'HeapLens',src:'img/heaplens.svg'},items:[
      {type:'docSidebar',sidebarId:'docsSidebar',position:'left',label:'Documentation'},
      {to:'/docs/getting-started/choose-host',label:'Hosts',position:'left'},
      {to:'/search',label:'Search',position:'right'},
      {href:'https://github.com/sachinkg12/heaplens',label:'GitHub',position:'right'},
    ]},
    footer:{style:'dark',links:[
      {title:'Start',items:[{label:'Install VS Code',to:'/docs/getting-started/installation'},{label:'Choose a host',to:'/docs/getting-started/choose-host'},{label:'Quick start',to:'/docs/getting-started/quick-start'}]},
      {title:'Investigate',items:[{label:'Views guide',to:'/docs/tabs-guide/overview-tab'},{label:'HeapQL reference',to:'/docs/api-reference/heapql'},{label:'MCP tools',to:'/docs/mcp/tools-reference'}]},
      {title:'Boundaries',items:[{label:'AI privacy',to:'/docs/ai-integration/privacy'},{label:'IntelliJ privacy policy',to:'/docs/runbook/intellij-privacy-policy'},{label:'Telemetry controls',to:'/docs/runbook/telemetry'},{label:'Support',to:'/docs/runbook/support'}]},
      {title:'Build',items:[{label:'Architecture',to:'/docs/architecture/system-overview'},{label:'Contributing',to:'/docs/architecture/contributing'},{label:'GitHub',href:'https://github.com/sachinkg12/heaplens'}]},
    ],copyright:`Copyright © ${new Date().getFullYear()} HeapLens Contributors. Apache 2.0.`},
    prism:{theme:prismThemes.github,darkTheme:prismThemes.dracula,additionalLanguages:['rust','bash','json','toml','java','sql']},
  } satisfies Preset.ThemeConfig,
};
export default config;
