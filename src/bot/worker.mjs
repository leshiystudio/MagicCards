// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import {chooseAction} from './policy.mjs';
self.onmessage=event=>{const {epoch,context}=event.data;const identity={epoch,revision:context.revision,decisionId:context.decisionId};try{self.postMessage({...identity,...chooseAction(context)});}catch(error){self.postMessage({...identity,error:error.message});}};
