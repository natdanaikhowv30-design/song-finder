songfinder-netlify/
├── netlify.toml
├── package.json
├── requirements.txt
├── runtime.txt
├── .nvmrc
├── .gitignore
├── Makefile
├── scripts/
│   ├── build.sh
│   └── make_zip.sh
├── data/
│   ├── inventory.json          # data inventory (ส่วนที่ 17.2)
│   ├── ropa.json               # ทะเบียนกิจกรรม (ส่วนที่ 29.3)
│   └── dpia.json               # ทะเบียนความเสี่ยง (ส่วนที่ 30.3)
├── privacy/
│   ├── __init__.py
│   ├── model.py                # validation ตามมาตรา 26/39
│   └── generate.py             # generator + CI gate
├── src/lib/
│   ├── resilience.mjs          # circuit breaker + bulkhead + budget
│   └── chaos.mjs               # fault injection
├── netlify/functions/
│   ├── search.mjs
│   ├── ropa.mjs
│   ├── dpia.mjs
│   └── chaos.mjs
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── tests/
    └── resilience.test.mjs
