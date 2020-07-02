#!/bin/bash

set -e
set -x
set -o pipefail

srcdir=`dirname $0`/..
srcdir=`realpath $srcdir`

which genienlp >/dev/null 2>&1 || pip3 install --user 'genienlp==0.3.0'
which genienlp

yarn global add thingpedia-cli

mkdir -p $srcdir/test/embeddings
