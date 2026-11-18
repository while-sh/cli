#!/usr/bin/env node
// wh (while-sh) : le mode dev de while. Aucune dépendance, Node 22 au moins.
import { principal } from '../lib/commande.mjs';

process.exitCode = await principal(process.argv.slice(2));
