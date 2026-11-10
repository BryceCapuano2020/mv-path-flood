# Is the Mill Valley bike path flooded?

A one-page site that answers from the live San Francisco tide gauge.

It is live at https://brycecapuano2020.github.io/mv-path-flood/

## How it works

The page reads NOAA station 9414290 every five minutes. It works out how far the water is running above the tide table, adds that to the next two days of the table, and lists when the water should be over the path. The flood line of 6.25 ft comes from rider reports and is approximate. Trust your eyes over this page.

## Tests

    npm test

Node 22, no dependencies. The logic lives in `flood.js`.

## Data

Tide readings and predictions from NOAA CO-OPS, station 9414290 (San Francisco).
